#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXTENSION_ARTIFACT_TARGET_SCHEMA = 'oliphaunt-extension-artifact-targets-v1';
const EXTENSION_ARTIFACT_TARGET_PROFILE_SCHEMA = 'oliphaunt-extension-artifact-target-profiles-v1';

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
  const publicationBlocker = resolve(path, 'publication-blocker.toml');
  if (existsSync(publicationBlocker)) {
    for (const forbidden of [release, resolve(path, 'VERSION'), resolve(path, 'CHANGELOG.md'), resolve(path, '.release-semantic-inputs.json')]) {
      if (existsSync(forbidden)) {
        fail(`${rel(forbidden)} is release-product metadata and is forbidden while publication-blocker.toml is present`);
      }
    }
    const artifactTargets = resolve(path, 'targets', 'artifacts.toml');
    if (!existsSync(artifactTargets)) {
      fail(`${rel(path)} must retain qualification target evidence while publication is deferred`);
    }
    await checkArtifactTargetOverride(artifactTargets);
  }
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
  const release = resolve(path, 'release.toml');
  if (!existsSync(release)) {
    fail(`${rel(path)} must own the linked contrib bundle release.toml`);
  }
  const releaseData = await parseToml(release);
  if (releaseData.kind !== 'exact-extension-bundle') {
    fail(`${rel(release)} must declare kind = 'exact-extension-bundle'`);
  }
  const expectedSqlNames = data.extensions.map((row) => row?.['sql-name']).sort();
  const declaredSqlNames = releaseData.extension_sql_names;
  if (
    !Array.isArray(declaredSqlNames) ||
    JSON.stringify(declaredSqlNames) !== JSON.stringify(expectedSqlNames)
  ) {
    fail(`${rel(release)} extension_sql_names must exactly match sorted postgres18.toml SQL names`);
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

async function checkContribMember(path) {
  const extensionId = basename(path);
  const row = (await contribManifestRows()).get(extensionId);
  if (row === undefined) {
    fail(`${rel(path)} must match a row in src/extensions/contrib/postgres18.toml`);
  }
  const release = resolve(path, 'release.toml');
  const version = resolve(path, 'VERSION');
  const changelog = resolve(path, 'CHANGELOG.md');
  for (const stale of [release, version, changelog]) {
    if (existsSync(stale)) {
      fail(`${rel(stale)} is stale per-member release metadata; contrib members are versioned by src/extensions/contrib/release.toml`);
    }
  }
  const artifactTargets = resolve(path, 'targets', 'artifacts.toml');
  if (!existsSync(artifactTargets)) {
    fail(`${rel(path)} must preserve fail-closed member target evidence in targets/artifacts.toml`);
  }
  await checkArtifactTargetOverride(artifactTargets);
  await parseAllToml(path);
}

async function checkArtifactTargetOverride(artifactTargets) {
  const targetData = await parseToml(artifactTargets);
  if (targetData.schema !== EXTENSION_ARTIFACT_TARGET_SCHEMA) {
    fail(`${rel(artifactTargets)} must use schema = ${JSON.stringify(EXTENSION_ARTIFACT_TARGET_SCHEMA)}`);
  }
  const hasTargets = Array.isArray(targetData.targets) && targetData.targets.length > 0;
  const hasProfiles = Array.isArray(targetData.profiles) && targetData.profiles.length > 0;
  if (!hasTargets && !hasProfiles) {
    fail(`${rel(artifactTargets)} must opt into at least one canonical profile or define [[targets]] rows`);
  }
  if (targetData.profiles !== undefined) {
    await checkArtifactTargetProfiles(artifactTargets, targetData);
  }
}

async function checkArtifactTargetProfiles(artifactTargets, targetData) {
  const relative = rel(artifactTargets);
  if (
    !Array.isArray(targetData.profiles) ||
    targetData.profiles.some((profile) => typeof profile !== 'string' || profile.length === 0)
  ) {
    fail(`${relative} profiles must be a list of non-empty profile ids`);
  }
  const profilePath = resolve(ROOT, 'tools/release/extension-target-profiles.toml');
  const profileData = await parseToml(profilePath);
  if (profileData.schema !== EXTENSION_ARTIFACT_TARGET_PROFILE_SCHEMA || !Array.isArray(profileData.profiles)) {
    fail(`${rel(profilePath)} must use schema ${EXTENSION_ARTIFACT_TARGET_PROFILE_SCHEMA} and define [[profiles]]`);
  }
  const knownProfiles = new Set();
  for (const profile of profileData.profiles) {
    if (!isRecord(profile) || typeof profile.id !== 'string' || profile.id.length === 0 || !Array.isArray(profile.targets) || profile.targets.length === 0) {
      fail(`${rel(profilePath)} profiles must define non-empty id and targets`);
    }
    if (knownProfiles.has(profile.id)) {
      fail(`${rel(profilePath)} profile ${profile.id} must be unique`);
    }
    knownProfiles.add(profile.id);
  }
  if (!isRecord(targetData.evidence)) {
    fail(`${relative} must define [evidence.<profile>] for every selected profile`);
  }
  const selectedProfiles = new Set();
  for (const profileId of targetData.profiles) {
    if (selectedProfiles.has(profileId)) {
      fail(`${relative} selects duplicate profile ${profileId}`);
    }
    selectedProfiles.add(profileId);
    if (!knownProfiles.has(profileId)) {
      fail(`${relative} selects unknown extension target profile ${profileId}`);
    }
    const evidence = targetData.evidence[profileId];
    if (!isRecord(evidence) || typeof evidence.kind !== 'string' || evidence.kind.length === 0 || typeof evidence.reference !== 'string' || evidence.reference.length === 0) {
      fail(`${relative} is missing non-empty evidence kind/reference for profile ${profileId}`);
    }
  }
  const staleEvidence = Object.keys(targetData.evidence).filter((profileId) => !selectedProfiles.has(profileId)).sort();
  if (staleEvidence.length > 0) {
    fail(`${relative} defines evidence for unselected profiles: ${staleEvidence.join(', ')}`);
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
    await checkContribMember(path);
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
