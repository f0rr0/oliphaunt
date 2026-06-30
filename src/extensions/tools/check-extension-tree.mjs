#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXTENSION_ARTIFACT_TARGET_SCHEMA = 'oliphaunt-extension-artifact-targets-v1';

function fail(message) {
  console.error(`extension-tree: ${message}`);
  process.exit(1);
}

function rel(path) {
  return relative(ROOT, path);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function parseToml(path) {
  try {
    return Bun.TOML.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot parse ${rel(path)}: ${detail}`);
  }
}

async function tomlFiles(root) {
  const files = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && child.endsWith('.toml')) {
        files.push(child);
      }
    }
  }
  await walk(root);
  return files.sort();
}

async function parseAllToml(path) {
  for (const tomlFile of await tomlFiles(path)) {
    await parseToml(tomlFile);
  }
}

async function checkExternal(path) {
  const source = resolve(path, 'source.toml');
  if (!existsSync(source)) {
    fail(`${rel(path)} must own source.toml`);
  }
  const sourceData = await parseToml(source);
  for (const key of ['name', 'url']) {
    if (typeof sourceData[key] !== 'string' || sourceData[key].length === 0) {
      fail(`${rel(source)} must define non-empty ${key}`);
    }
  }

  const release = resolve(path, 'release.toml');
  if (existsSync(release)) {
    const releaseData = await parseToml(release);
    if (releaseData.kind === 'exact-extension-artifact') {
      const artifactTargets = resolve(path, 'targets', 'artifacts.toml');
      if (existsSync(artifactTargets)) {
        await checkArtifactTargetOverride(artifactTargets);
      }
    }
  }

  await parseAllToml(path);
}

async function checkContrib(path) {
  const manifest = resolve(path, 'postgres18.toml');
  if (!existsSync(manifest)) {
    fail(`${rel(path)} must contain postgres18.toml`);
  }
  const data = await parseToml(manifest);
  if (data['format-version'] !== 1) {
    fail(`${rel(manifest)} must use format-version = 1`);
  }
  if (data['postgres-version'] !== '18.4') {
    fail(`${rel(manifest)} must target PostgreSQL 18.4`);
  }
  if (data['source-kind'] !== 'postgres-contrib') {
    fail(`${rel(manifest)} must describe postgres-contrib`);
  }
  if (!Array.isArray(data.extensions) || data.extensions.length === 0) {
    fail(`${rel(manifest)} must define extension rows`);
  }
  await parseAllToml(path);
}

async function contribManifestRows() {
  const manifest = resolve(ROOT, 'src/extensions/contrib/postgres18.toml');
  const data = await parseToml(manifest);
  const rows = data.extensions;
  if (!Array.isArray(rows)) {
    fail(`${rel(manifest)} must define extension rows`);
  }
  const parsed = new Map();
  for (const row of rows) {
    if (!isRecord(row)) {
      continue;
    }
    const extensionId = row.id;
    if (typeof extensionId === 'string' && extensionId.length > 0) {
      parsed.set(extensionId, row);
    }
  }
  return parsed;
}

async function checkArtifactProduct(path, { family }) {
  const release = resolve(path, 'release.toml');
  if (!existsSync(release)) {
    fail(`${rel(path)} must own release.toml`);
  }
  const releaseData = await parseToml(release);
  if (releaseData.kind !== 'exact-extension-artifact') {
    fail(`${rel(release)} must declare kind = 'exact-extension-artifact'`);
  }
  const sqlName = releaseData.extension_sql_name;
  if (typeof sqlName !== 'string' || sqlName.length === 0) {
    fail(`${rel(release)} must declare extension_sql_name`);
  }
  const artifactTargets = resolve(path, 'targets', 'artifacts.toml');
  if (existsSync(artifactTargets)) {
    await checkArtifactTargetOverride(artifactTargets);
  }
  if (family === 'contrib') {
    const extensionId = basename(path);
    const row = (await contribManifestRows()).get(extensionId);
    if (row === undefined) {
      fail(`${rel(path)} must match a row in src/extensions/contrib/postgres18.toml`);
    }
    if (row['sql-name'] !== sqlName) {
      fail(
        `${rel(release)} extension_sql_name ${JSON.stringify(sqlName)} ` +
          `must match contrib manifest sql-name ${JSON.stringify(row['sql-name'])}`,
      );
    }
  }
  await parseAllToml(path);
}

async function checkArtifactTargetOverride(artifactTargets) {
  const targetData = await parseToml(artifactTargets);
  if (targetData.schema !== EXTENSION_ARTIFACT_TARGET_SCHEMA) {
    fail(`${rel(artifactTargets)} must use schema = ${JSON.stringify(EXTENSION_ARTIFACT_TARGET_SCHEMA)}`);
  }
  if (!Array.isArray(targetData.targets) || targetData.targets.length === 0) {
    fail(`${rel(artifactTargets)} must define [[targets]] rows`);
  }
}

async function main(argv) {
  if (argv.length !== 1) {
    fail('usage: check-extension-tree.mjs <src/extensions/{contrib|external/<name>}>');
  }
  const path = resolve(ROOT, argv[0]);
  const relativePath = rel(path);
  if (relativePath.startsWith('..') || relativePath === '') {
    fail(`path is outside repository: ${path}`);
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`path does not exist: ${relativePath}`);
  }

  if (path === resolve(ROOT, 'src/extensions/contrib')) {
    await checkContrib(path);
  } else if (dirname(path) === resolve(ROOT, 'src/extensions/contrib')) {
    await checkArtifactProduct(path, { family: 'contrib' });
  } else if (dirname(path) === resolve(ROOT, 'src/extensions/external')) {
    await checkExternal(path);
    const release = resolve(path, 'release.toml');
    if (existsSync(release) && (await parseToml(release)).kind === 'exact-extension-artifact') {
      await checkArtifactProduct(path, { family: 'external' });
    }
  } else {
    fail(`unsupported extension tree path: ${relativePath}`);
  }
}

await main(Bun.argv.slice(2));
