#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPortableArchiveEntries } from "./portable-archive.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = "check-cargo-package-test-closure.mjs";
const TIMEOUT_MS = 30 * 60_000;
const CARGO_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function regularFile(file, context) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (cause) {
    throw error(`${context} is missing: ${file}: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw error(`${context} must be a regular, non-symlink file: ${file}`);
  }
  return metadata;
}

function parseManifest(file, context) {
  regularFile(file, context);
  try {
    return Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw error(`${context} is not valid TOML: ${file}: ${cause.message}`);
  }
}

function packageIdentity(manifest, context) {
  const pkg = manifest?.package;
  if (
    pkg === null
    || Array.isArray(pkg)
    || typeof pkg !== "object"
    || typeof pkg.name !== "string"
    || typeof pkg.version !== "string"
    || !pkg.name
    || !pkg.version
  ) {
    throw error(`${context} must declare non-empty package.name and package.version strings`);
  }
  if (!CARGO_PACKAGE_NAME.test(pkg.name)) {
    throw error(`${context} declares unsafe Cargo package name ${JSON.stringify(pkg.name)}`);
  }
  return { name: pkg.name, version: pkg.version };
}

function dependencyTables(manifest) {
  const tables = [];
  for (const name of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    if (manifest?.[name] !== undefined) tables.push(manifest[name]);
  }
  const targets = manifest?.target ?? {};
  if (targets === null || Array.isArray(targets) || typeof targets !== "object") {
    throw error("target dependencies must be TOML tables");
  }
  for (const target of Object.values(targets)) {
    if (target === null || Array.isArray(target) || typeof target !== "object") {
      throw error("each target dependency section must be a TOML table");
    }
    for (const name of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      if (target[name] !== undefined) tables.push(target[name]);
    }
  }
  return tables;
}

function dependencyRows(manifest) {
  const rows = [];
  for (const table of dependencyTables(manifest)) {
    if (table === null || Array.isArray(table) || typeof table !== "object") {
      throw error("dependency sections must be TOML tables");
    }
    for (const [alias, raw] of Object.entries(table)) {
      const value = typeof raw === "string" ? { version: raw } : raw;
      if (value === null || Array.isArray(value) || typeof value !== "object") {
        throw error(`dependency ${alias} must be a version string or TOML table`);
      }
      const name = typeof value.package === "string" ? value.package : alias;
      if (!CARGO_PACKAGE_NAME.test(alias) || !CARGO_PACKAGE_NAME.test(name)) {
        throw error(`dependency declares unsafe Cargo package name or alias: ${alias} -> ${name}`);
      }
      rows.push({
        alias,
        name,
        path: typeof value.path === "string" ? value.path : null,
        version: typeof value.version === "string" ? value.version : null,
        features: Array.isArray(value.features)
          ? value.features.filter((feature) => typeof feature === "string")
          : [],
      });
    }
  }
  return rows;
}

function exactVersion(requirement, dependency) {
  const match = requirement?.match(/^=([0-9A-Za-z][0-9A-Za-z.+-]*)$/u);
  if (!match) {
    throw error(`stub dependency ${dependency} must use an exact =version requirement, got ${requirement ?? "none"}`);
  }
  return match[1];
}

function addPatch(patches, name, directory, context) {
  const resolved = realpathSync(directory);
  const previous = patches.get(name);
  if (previous !== undefined && previous !== resolved) {
    throw error(`${name} has conflicting local patches: ${previous} and ${resolved} (${context})`);
  }
  patches.set(name, resolved);
}

function copyCleanDependencySource(source, destination) {
  const ignoredDirectories = new Set([".git", "artifacts", "payload", "target"]);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const visit = (sourceDirectory, destinationDirectory) => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name))) {
      if (entry.name === ".DS_Store" || (entry.isDirectory() && ignoredDirectories.has(entry.name))) {
        continue;
      }
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const metadata = lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw error(`path dependency source must not contain symbolic links: ${sourcePath}`);
      }
      if (metadata.isDirectory()) {
        mkdirSync(destinationPath, { recursive: true });
        visit(sourcePath, destinationPath);
      } else if (metadata.isFile()) {
        copyFileSync(sourcePath, destinationPath);
        chmodSync(destinationPath, metadata.mode & 0o777);
      } else {
        throw error(`path dependency source contains a special file: ${sourcePath}`);
      }
    }
  };
  visit(source, destination);
}

function pathDependencyPatches(manifests, scratch) {
  const patches = new Map();
  const sourceDirectories = new Map();
  for (const manifestFile of manifests) {
    const resolvedManifest = path.resolve(manifestFile);
    const manifest = parseManifest(resolvedManifest, "path-dependency source manifest");
    for (const dependency of dependencyRows(manifest).filter((row) => row.path !== null)) {
      const directory = path.resolve(path.dirname(resolvedManifest), dependency.path);
      const localManifestFile = path.join(directory, "Cargo.toml");
      const localManifest = parseManifest(localManifestFile, `local patch for ${dependency.name}`);
      const local = packageIdentity(localManifest, `local patch for ${dependency.name}`);
      if (local.name !== dependency.name) {
        throw error(`local patch ${localManifestFile} declares ${local.name}, expected ${dependency.name}`);
      }
      if (dependency.version !== null && exactVersion(dependency.version, dependency.name) !== local.version) {
        throw error(
          `local patch ${dependency.name}@${local.version} does not satisfy ${dependency.version}`,
        );
      }
      const realSource = realpathSync(directory);
      const previousSource = sourceDirectories.get(dependency.name);
      if (previousSource !== undefined && previousSource !== realSource) {
        throw error(
          `${dependency.name} has conflicting path-dependency sources: ${previousSource} and ${realSource}`,
        );
      }
      sourceDirectories.set(dependency.name, realSource);
      const staged = path.join(scratch, "path-dependency-sources", dependency.name);
      if (!patches.has(dependency.name)) copyCleanDependencySource(directory, staged);
      addPatch(patches, dependency.name, staged, resolvedManifest);
    }
  }
  return patches;
}

function forwardedStubFeatures(manifest, aliases) {
  const features = new Map([...aliases].map((alias) => [alias, new Set()]));
  const packageFeatures = manifest.features ?? {};
  if (packageFeatures === null || Array.isArray(packageFeatures) || typeof packageFeatures !== "object") {
    throw error("package features must be a TOML table");
  }
  for (const members of Object.values(packageFeatures)) {
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      if (typeof member !== "string" || !member.includes("/")) continue;
      const [alias, feature] = member.split("/", 2);
      features.get(alias?.replace(/^dep:/u, "").replace(/\?$/u, ""))?.add(feature);
    }
  }
  return features;
}

function createStubPatches({ manifest, scratch, names, prefixes }) {
  const dependencies = dependencyRows(manifest);
  const selected = dependencies.filter(({ name }) =>
    names.has(name) || prefixes.some((prefix) => name.startsWith(prefix)));
  for (const name of names) {
    if (!selected.some((dependency) => dependency.name === name)) {
      throw error(`requested stub dependency is absent from the packaged manifest: ${name}`);
    }
  }
  for (const prefix of prefixes) {
    if (!selected.some((dependency) => dependency.name.startsWith(prefix))) {
      throw error(`stub dependency prefix matched no packaged dependency: ${prefix}`);
    }
  }

  const aliasesByName = new Map();
  for (const dependency of selected) {
    const aliases = aliasesByName.get(dependency.name) ?? new Set();
    aliases.add(dependency.alias);
    aliasesByName.set(dependency.name, aliases);
  }
  const allAliases = new Set([...aliasesByName.values()].flatMap((aliases) => [...aliases]));
  const forwarded = forwardedStubFeatures(manifest, allAliases);
  const patches = new Map();
  for (const name of [...aliasesByName.keys()].sort(compareText)) {
    const rows = selected.filter((dependency) => dependency.name === name);
    const versions = new Set(rows.map((dependency) => exactVersion(dependency.version, name)));
    if (versions.size !== 1) {
      throw error(`stub dependency ${name} has conflicting exact versions: ${[...versions].join(", ")}`);
    }
    const [version] = versions;
    const features = new Set(rows.flatMap((dependency) => dependency.features));
    for (const alias of aliasesByName.get(name)) {
      for (const feature of forwarded.get(alias) ?? []) features.add(feature);
    }
    const directory = path.join(scratch, "dependency-stubs", name);
    mkdirSync(path.join(directory, "src"), { recursive: true });
    const featureRows = [...features].sort(compareText).map((feature) =>
      `${JSON.stringify(feature)} = []`);
    writeFileSync(path.join(directory, "Cargo.toml"), [
      "[package]",
      `name = ${JSON.stringify(name)}`,
      `version = ${JSON.stringify(version)}`,
      'edition = "2024"',
      "publish = false",
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "",
      ...(featureRows.length > 0 ? ["[features]", ...featureRows, ""] : []),
      "[workspace]",
      "",
    ].join("\n"));
    writeFileSync(path.join(directory, "src/lib.rs"), "#![forbid(unsafe_code)]\n");
    addPatch(patches, name, directory, "generated test-closure stub");
  }
  return patches;
}

function extractCrate(cratePath, scratch) {
  const entries = readPortableArchiveEntries(cratePath);
  const roots = new Set([...entries.keys()].map((name) => name.split("/", 1)[0]));
  if (roots.size !== 1) {
    throw error(`${cratePath} must contain exactly one package root, found ${roots.size}`);
  }
  const [rootName] = roots;
  for (const entry of entries.values()) {
    const destination = path.join(scratch, ...entry.name.split("/"));
    if (entry.isDirectory) {
      mkdirSync(destination, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, entry.data(), { flag: "wx", mode: entry.mode & 0o777 });
    chmodSync(destination, entry.mode & 0o777);
  }
  const packageRoot = path.join(scratch, rootName);
  const manifestFile = path.join(packageRoot, "Cargo.toml");
  const manifest = parseManifest(manifestFile, "extracted package manifest");
  const identity = packageIdentity(manifest, "extracted package manifest");
  if (rootName !== `${identity.name}-${identity.version}`) {
    throw error(`${cratePath} root is ${rootName}, expected ${identity.name}-${identity.version}`);
  }
  return { identity, manifest, manifestFile, packageRoot };
}

function writePatchConfig(scratch, patches) {
  const configDir = path.join(scratch, ".cargo");
  mkdirSync(configDir, { recursive: true });
  const rows = [...patches.entries()].sort(([left], [right]) => compareText(left, right));
  writeFileSync(path.join(configDir, "config.toml"), [
    "[net]",
    "offline = true",
    "",
    ...(rows.length > 0
      ? [
          "[patch.crates-io]",
          ...rows.map(([name, directory]) =>
            `${JSON.stringify(name)} = { path = ${JSON.stringify(directory)} }`),
          "",
        ]
      : []),
  ].join("\n"));
}

export function verifyPackagedCargoTestClosure({
  cratePath,
  targetDir = process.env.CARGO_TARGET_DIR ?? path.join(ROOT, "target/cargo-package-test-closure"),
  pathDependencyManifests = [],
  stubDependencies = [],
  stubDependencyPrefixes = [],
  allFeatures = false,
  noDefaultFeatures = false,
  features = [],
  lib = false,
} = {}) {
  if (typeof cratePath !== "string" || !cratePath) throw error("cratePath is required");
  if (allFeatures && features.length > 0) {
    throw error("allFeatures and explicit features are mutually exclusive");
  }
  const crate = path.resolve(cratePath);
  regularFile(crate, "crate archive");
  const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "oliphaunt-cargo-package-test-"));
  try {
    const extracted = extractCrate(crate, scratch);
    const patches = pathDependencyPatches(pathDependencyManifests, scratch);
    const stubs = createStubPatches({
      manifest: extracted.manifest,
      scratch,
      names: new Set(stubDependencies),
      prefixes: [...stubDependencyPrefixes],
    });
    for (const [name, directory] of stubs) addPatch(patches, name, directory, "stub dependency");
    writePatchConfig(scratch, patches);

    const cargoEnvironment = { ...process.env };
    for (const name of Object.keys(cargoEnvironment)) {
      if (name.startsWith("OLIPHAUNT_")) delete cargoEnvironment[name];
    }
    cargoEnvironment.CARGO_TARGET_DIR = path.resolve(targetDir);
    cargoEnvironment.CARGO_TERM_COLOR = "never";
    const runCargo = (args) => {
      const result = spawnSync("cargo", args, {
        cwd: scratch,
        env: cargoEnvironment,
        stdio: "inherit",
        timeout: TIMEOUT_MS,
      });
      if (result.error !== undefined) {
        throw error(`cargo ${args.join(" ")} failed to start for ${path.basename(crate)}: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw error(
          `cargo ${args.join(" ")} exited ${result.status ?? `for signal ${result.signal ?? "unknown"}`} `
            + `for ${path.basename(crate)}`,
        );
      }
    };
    runCargo(["generate-lockfile", "--manifest-path", extracted.manifestFile, "--offline"]);

    const args = ["test", "--manifest-path", extracted.manifestFile, "--locked", "--offline", "--no-run"];
    if (allFeatures) args.push("--all-features");
    if (noDefaultFeatures) args.push("--no-default-features");
    if (features.length > 0) args.push("--features", features.join(","));
    if (lib) args.push("--lib");
    runCargo(args);
    console.log(
      `Cargo package test closure verified: ${extracted.identity.name}@${extracted.identity.version}`,
    );
    return extracted.identity;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = {
    cratePath: null,
    targetDir: process.env.CARGO_TARGET_DIR ?? path.join(ROOT, "target/cargo-package-test-closure"),
    pathDependencyManifests: [],
    stubDependencies: [],
    stubDependencyPrefixes: [],
    allFeatures: false,
    noDefaultFeatures: false,
    features: [],
    lib: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--crate") {
      options.cratePath = requiredValue(argv, ++index, option);
    } else if (option === "--target-dir") {
      options.targetDir = requiredValue(argv, ++index, option);
    } else if (option === "--path-dependencies-from") {
      options.pathDependencyManifests.push(requiredValue(argv, ++index, option));
    } else if (option === "--stub-dependency") {
      options.stubDependencies.push(requiredValue(argv, ++index, option));
    } else if (option === "--stub-dependency-prefix") {
      options.stubDependencyPrefixes.push(requiredValue(argv, ++index, option));
    } else if (option === "--features") {
      options.features.push(...requiredValue(argv, ++index, option).split(",").filter(Boolean));
    } else if (option === "--all-features") {
      options.allFeatures = true;
    } else if (option === "--no-default-features") {
      options.noDefaultFeatures = true;
    } else if (option === "--lib") {
      options.lib = true;
    } else {
      throw error(`unknown argument: ${option}`);
    }
  }
  if (!options.cratePath) {
    throw error(
      "usage: check-cargo-package-test-closure.mjs --crate FILE [--path-dependencies-from Cargo.toml] "
        + "[--stub-dependency NAME] [--stub-dependency-prefix PREFIX] [--all-features|--features LIST] "
        + "[--no-default-features] [--lib]",
    );
  }
  return options;
}

if (import.meta.main) {
  try {
    verifyPackagedCargoTestClosure(parseArgs(Bun.argv.slice(2)));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
