#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';

function fail(message) {
  console.error(`cargo-artifact-patches.mjs: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  if (argv.length !== 2) {
    fail('usage: src/sdks/rust/tools/cargo-artifact-patches.mjs <repo-root> <packages.json>');
  }
  return {
    root: path.resolve(argv[0]),
    manifest: path.isAbsolute(argv[1]) ? argv[1] : path.resolve(argv[0], argv[1]),
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

const { root, manifest } = parseArgs(Bun.argv.slice(2));
let data;
try {
  data = JSON.parse(await fs.readFile(manifest, 'utf8'));
} catch (error) {
  fail(`could not read Cargo artifact package manifest ${manifest}: ${error.message}`);
}

if (data === null || typeof data !== 'object' || !Array.isArray(data.packages)) {
  fail(`${manifest} must contain a packages array`);
}

for (const [index, artifact] of data.packages.entries()) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    fail(`${manifest} package row ${index} must be an object`);
  }
  const { name, manifestPath } = artifact;
  if (typeof name !== 'string' || name.length === 0) {
    fail(`${manifest} package row ${index} must declare a non-empty name`);
  }
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    fail(`${manifest} package row ${index} must declare a non-empty manifestPath`);
  }
  const artifactManifest = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.join(root, manifestPath);
  console.log(`${name} = { path = ${tomlString(path.dirname(artifactManifest))} }`);
}
