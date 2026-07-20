#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { compareText, localPublishArtifactRows } from "./release-artifact-targets.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const TOOL = "local_registry_metadata.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(1);
}

function usage() {
  return `usage: tools/release/local_registry_metadata.mjs <command>

Commands:
  local-publish-artifacts [--aggregate-only]
  discover-extension-manifests --root PATH [--root PATH...]
`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

export function localPublishArtifactNames({ aggregateOnly = false } = {}) {
  const names = localPublishArtifactRows({ aggregateOnly }, TOOL).map((row) => row.artifactName);
  if (names.length === 0) {
    fail("release graph returned no local-publish artifacts");
  }
  const unique = sortedUnique(names);
  if (unique.length !== names.length) {
    const duplicates = unique.filter((name) => names.filter((candidate) => candidate === name).length > 1);
    fail(`release graph returned duplicate local-publish artifacts: ${duplicates.join(", ")}`);
  }
  return unique;
}

export function localPublishArtifacts() {
  return localPublishArtifactNames();
}

export function localPublishAggregateArtifacts() {
  return localPublishArtifactNames({ aggregateOnly: true });
}

function repoRelativeOrAbsolute(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file
    : relative.split(path.sep).join("/");
}

function extensionManifestIdentity(manifest) {
  let data;
  try {
    data = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return ["path", realpathSync(manifest)];
  }
  const product = data.product;
  const version = data.version;
  const sqlName = data.sqlName;
  if ([product, version, sqlName].every((value) => typeof value === "string" && value.length > 0)) {
    return ["extension", product, version, sqlName];
  }
  return ["path", realpathSync(manifest)];
}

function extensionManifestCandidates(root) {
  if (!existsSync(root)) {
    return [];
  }
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`${TOOL}: extension manifest input must not be a symbolic link or junction: ${root}`);
  }
  if (stat.isFile() && path.basename(root) === "extension-artifacts.json") {
    return [root];
  }
  if (stat.isFile()) {
    return [];
  }
  if (!stat.isDirectory()) {
    throw new Error(`${TOOL}: extension manifest input has an unsupported filesystem type: ${root}`);
  }
  const manifests = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const candidateStat = lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new Error(
          `${TOOL}: extension manifest input must not contain a symbolic link or junction: ${candidate}`,
        );
      }
      if (candidateStat.isDirectory()) {
        visit(candidate);
      } else if (candidateStat.isFile()) {
        if (entry.name === "extension-artifacts.json") manifests.push(candidate);
      } else {
        throw new Error(
          `${TOOL}: extension manifest input contains an unsupported filesystem entry: ${candidate}`,
        );
      }
    }
  };
  visit(root);
  return manifests;
}

export function discoverExtensionManifests(roots) {
  const manifests = new Map();
  const seenPaths = new Set();
  for (const root of roots) {
    for (const manifest of extensionManifestCandidates(root)) {
      const resolved = realpathSync(manifest);
      if (seenPaths.has(resolved)) {
        continue;
      }
      seenPaths.add(resolved);
      const identity = JSON.stringify(extensionManifestIdentity(manifest));
      if (!manifests.has(identity)) {
        manifests.set(identity, manifest);
      }
    }
  }
  return [...manifests.values()];
}

function parseRoots(argv) {
  const roots = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") {
      if (index + 1 >= argv.length) {
        fail("--root requires a value");
      }
      roots.push(path.resolve(ROOT, argv[index + 1]));
      index += 1;
    } else if (value.startsWith("--root=")) {
      roots.push(path.resolve(ROOT, value.slice("--root=".length)));
    } else {
      fail(`unknown argument: ${value}`);
    }
  }
  if (roots.length === 0) {
    fail("discover-extension-manifests requires at least one --root");
  }
  return roots;
}

function printJson(value) {
  console.log(`${JSON.stringify(value, null, 2)}\n`.trimEnd());
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(usage());
    return command === undefined ? 1 : 0;
  }
  if (command === "local-publish-artifacts") {
    let aggregateOnly = false;
    for (const arg of rest) {
      if (arg === "--aggregate-only") {
        aggregateOnly = true;
      } else {
        fail(`unknown argument: ${arg}`);
      }
    }
    printJson(localPublishArtifactNames({ aggregateOnly }));
    return 0;
  }
  if (command === "discover-extension-manifests") {
    printJson(discoverExtensionManifests(parseRoots(rest)).map(repoRelativeOrAbsolute));
    return 0;
  }
  fail(`unknown command: ${command}`);
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
