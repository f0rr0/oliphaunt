#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const EXTENSION_ID = /^[a-z][a-z0-9_]{0,127}$/u;
const SQL_EXTENSION_NAME = /^[a-z][a-z0-9_-]{0,127}$/u;

const CURRENT_SOURCE_DOMAINS = new Set([
  'src/postgres/versions/18',
  'src/sources',
  'src/extensions',
  'src/shared',
]);

const CURRENT_SOURCE_DOMAIN_PROJECTS = new Set([
  'src/postgres/versions/18',
  'src/sources/third-party/shared',
  'src/sources/third-party/native',
  'src/sources/third-party/wasix',
  'src/sources/toolchains',
  'src/extensions',
  'src/shared/js-core',
]);

const TARGET_SOURCE_DOMAINS = new Set([
  'src/postgres',
  'src/sources',
  'src/extensions',
  'src/runtimes',
  'src/shared',
  'src/sdks',
  'src/bindings',
  'src/docs',
]);

const CURRENT_PRODUCT_ROOTS = new Map([
  ['src/runtimes/liboliphaunt/native', 'liboliphaunt-native'],
  ['src/sdks/rust', 'oliphaunt-rust'],
  ['src/sdks/swift', 'oliphaunt-swift'],
  ['src/sdks/kotlin', 'oliphaunt-kotlin'],
  ['src/sdks/react-native', 'oliphaunt-react-native'],
  ['src/sdks/js', 'oliphaunt-js'],
  ['src/bindings/wasix-rust', 'oliphaunt-wasix-rust'],
  ['src/docs', 'docs'],
]);

const ALLOWED_SRC_TOP_LEVEL = new Set([
  ...[...CURRENT_SOURCE_DOMAINS].map((item) => item.replace(/^src\//u, '')),
  ...[...TARGET_SOURCE_DOMAINS].map((item) => item.replace(/^src\//u, '')),
  ...[...CURRENT_PRODUCT_ROOTS.keys()].map((item) => item.replace(/^src\//u, '')),
]);

const RETIRED_ROOTS = new Set(['assets', 'crates', 'fixtures', 'liboliphaunt-native', 'sdks']);
const FORBIDDEN_PRODUCT_IDENTITIES = new Set(['@oliphaunt/sdk-apple', 'apple-sdk', 'oliphaunt-apple']);
const FORBIDDEN_RETIRED_RELEASE_TOOL_TEXT = new Set(['release-plz', 'git-cliff']);

const SDK_RUNTIME_SOURCE_PREFIXES = [
  'src/sdks/rust/src/',
  'src/sdks/swift/Sources/',
  'src/sdks/kotlin/oliphaunt/src/commonMain/',
  'src/sdks/kotlin/oliphaunt/src/androidMain/',
  'src/sdks/kotlin/oliphaunt/src/nativeMain/',
  'src/sdks/react-native/src/',
  'src/sdks/react-native/ios/',
  'src/sdks/react-native/android/src/main/',
  'src/sdks/js/src/',
];

const TRANSITIONAL_EXTENSION_RULE_ALLOWLIST = new Set([
  'src/sdks/js/src/config.ts\0if (extension === \'pg_search\')',
  'src/sdks/js/src/config.ts\0libraries.add(\'pg_search\')',
]);

const TRANSITIONAL_EXTENSION_RULE_FILES = new Set([
  'src/sdks/rust/src/extension.rs',
  'src/sdks/rust/src/runtime_resources.rs',
  'src/sdks/swift/Sources/COliphaunt/include/oliphaunt.h',
  'src/sdks/kotlin/oliphaunt/src/androidMain/cpp/include/oliphaunt.h',
  'src/sdks/react-native/android/src/main/cpp/include/oliphaunt.h',
]);

const PROMOTED_CATALOG = 'src/extensions/catalog/extensions.promoted.toml';
const SMOKE_CATALOG = 'src/extensions/catalog/extensions.smoke.toml';
const GENERATED_CATALOG = 'src/extensions/generated/extensions.catalog.json';
const GENERATED_BUILD_PLAN = 'src/extensions/generated/extensions.build-plan.json';
const GENERATED_EXTENSION_DOCS = 'src/extensions/generated/docs/extensions.json';
const GENERATED_EXTENSION_EVIDENCE = 'src/extensions/generated/docs/extension-evidence.json';
const EVIDENCE_MATRIX = 'src/extensions/evidence/matrix.toml';
const EVIDENCE_RUN_SCHEMA = 'src/extensions/evidence/schemas/run.schema.json';
const EVIDENCE_MATRIX_SCHEMA = 'src/extensions/evidence/schemas/matrix.schema.json';
const EVIDENCE_RUNS = 'src/extensions/evidence/runs';
const GENERATED_SDK_METADATA = [
  'src/extensions/generated/sdk/rust.json',
  'src/extensions/generated/sdk/swift.json',
  'src/extensions/generated/sdk/kotlin.json',
  'src/extensions/generated/sdk/js.json',
  'src/extensions/generated/sdk/react-native.json',
];
const GENERATED_SDK_PACKAGE_METADATA = [
  'src/sdks/js/src/generated/extensions.ts',
  'src/sdks/kotlin/oliphaunt/src/generated/extensions.json',
  'src/sdks/react-native/src/generated/extensions.ts',
  'src/sdks/react-native/src/generated/extensions.json',
];
const GENERATED_MOBILE_REGISTRY = 'src/extensions/generated/mobile/static-registry.json';
const GENERATED_WASIX_METADATA = 'src/extensions/generated/wasix/extensions.json';
const GENERATED_TSV = [
  'src/extensions/generated/contrib-build.tsv',
  'src/extensions/generated/pgxs-build.tsv',
];

class PolicyFailure extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyFailure';
  }
}

class TextDecodeFailure extends Error {
  constructor(relativePath, cause) {
    super(`${relativePath} is not valid UTF-8: ${cause.message}`);
    this.name = 'TextDecodeFailure';
  }
}

function fail(message) {
  throw new PolicyFailure(message);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function absolute(relativePath) {
  return path.join(ROOT, relativePath);
}

function requireFile(relativePath) {
  if (!existsSync(absolute(relativePath)) || !statSync(absolute(relativePath)).isFile()) {
    fail(`missing required file: ${relativePath}`);
  }
}

function requireDir(relativePath) {
  if (!existsSync(absolute(relativePath)) || !statSync(absolute(relativePath)).isDirectory()) {
    fail(`missing required directory: ${relativePath}`);
  }
}

function trackedFiles(...paths) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.error) {
    fail(`git ls-files failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git ls-files failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .sort(compareText);
}

async function readText(relativePath) {
  const bytes = await readFile(absolute(relativePath));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TextDecodeFailure(relativePath, error);
  }
}

async function readToml(relativePath) {
  requireFile(relativePath);
  try {
    return Bun.TOML.parse(await readText(relativePath));
  } catch (error) {
    if (error instanceof TextDecodeFailure) {
      fail(error.message);
    }
    fail(`${relativePath} is invalid TOML: ${error.message}`);
  }
}

async function readJson(relativePath) {
  requireFile(relativePath);
  let value;
  try {
    value = JSON.parse(await readText(relativePath));
  } catch (error) {
    if (error instanceof TextDecodeFailure) {
      fail(error.message);
    }
    fail(`${relativePath} is invalid JSON: ${error.message}`);
  }
  if (!isRecord(value)) {
    fail(`${relativePath} must contain a JSON object`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pythonTruthy(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function validateExtensionId(value, context) {
  if (typeof value !== 'string' || !EXTENSION_ID.test(value)) {
    fail(`${context} has invalid exact SQL extension id ${JSON.stringify(value)}`);
  }
  return value;
}

function validateSqlExtensionName(value, context) {
  if (typeof value !== 'string' || !SQL_EXTENSION_NAME.test(value)) {
    fail(`${context} has invalid exact SQL extension name ${JSON.stringify(value)}`);
  }
  return value;
}

function validateUniqueIds(ids, context) {
  const seen = new Set();
  const duplicates = new Set();
  for (const extensionId of ids) {
    if (seen.has(extensionId)) {
      duplicates.add(extensionId);
    }
    seen.add(extensionId);
  }
  if (duplicates.size > 0) {
    fail(`${context} has duplicate extension ids: ${JSON.stringify([...duplicates].sort(compareText))}`);
  }
}

async function extensionRows(relativePath) {
  const value = (await readToml(relativePath)).extensions;
  if (!Array.isArray(value)) {
    fail(`${relativePath} must define [[extensions]] rows`);
  }
  const rows = [];
  for (const [index, row] of value.entries()) {
    if (!isRecord(row)) {
      fail(`${relativePath} extensions[${index}] must be a table`);
    }
    rows.push(row);
  }
  return rows;
}

function checkSourceDomains() {
  for (const sourceDomain of CURRENT_SOURCE_DOMAINS) {
    requireDir(sourceDomain);
  }
  for (const sourceDomain of CURRENT_SOURCE_DOMAIN_PROJECTS) {
    requireFile(path.posix.join(sourceDomain, 'moon.yml'));
  }
  requireFile('src/shared/contracts/moon.yml');
  requireFile('src/shared/fixtures/moon.yml');
  for (const retired of RETIRED_ROOTS) {
    const files = trackedFiles(retired);
    if (files.length > 0) {
      fail(`retired root source alias ${retired}/ still has tracked files: ${JSON.stringify(files.slice(0, 8))}`);
    }
  }

  const srcChildren = new Set(
    trackedFiles('src')
      .filter((item) => item.includes('/'))
      .map((item) => item.split('/')[1]),
  );
  const unexpected = [...srcChildren].filter((item) => !ALLOWED_SRC_TOP_LEVEL.has(item)).sort(compareText);
  if (unexpected.length > 0) {
    fail(`unexpected top-level source domains under src/: ${JSON.stringify(unexpected)}`);
  }
}

async function checkSourceSpinePolicy() {
  const file = 'tools/xtask/src/source_spine.rs';
  const sourceSpine = await readText(file);
  if (!sourceSpine.includes('Path::new(SOURCE_CHECKOUT_ROOT).join(name)')) {
    fail(`${file} must derive source checkout paths from SOURCE_CHECKOUT_ROOT and source name`);
  }
  for (const forbidden of [
    '"pgtap" =>',
    '"postgis" =>',
    '"pgvector" =>',
    'target/oliphaunt-sources/checkouts/pgtap',
    'target/oliphaunt-sources/checkouts/postgis',
    'target/oliphaunt-sources/checkouts/pgvector',
  ]) {
    if (sourceSpine.includes(forbidden)) {
      fail(`${file} must not hardcode source checkout mapping ${JSON.stringify(forbidden)}`);
    }
  }
}

async function checkXtaskExtensionPolicy() {
  const file = 'tools/xtask/src/postgres_guard.rs';
  const text = await readText(file);
  if (text.includes('extension.build_kind == "postgis"')) {
    fail(`${file} must not key PostGIS source-shape checks off the reusable build-kind family`);
  }
  if (!text.includes('extension.source_kind == "postgis"')) {
    fail(`${file} must keep PostGIS source-shape checks keyed to source_kind`);
  }
}

async function checkProductRoots() {
  for (const [productRoot, projectId] of CURRENT_PRODUCT_ROOTS) {
    const moonYml = path.posix.join(productRoot, 'moon.yml');
    requireFile(moonYml);
    const text = await readText(moonYml);
    if (!text.includes(`id: "${projectId}"`)) {
      fail(`${productRoot}/moon.yml must declare id ${JSON.stringify(projectId)}`);
    }
  }

  for (const forbidden of ['src/apple-sdk', 'src/oliphaunt-apple', 'src/apple']) {
    const files = trackedFiles(forbidden);
    if (files.length > 0) {
      fail(`forbidden Swift SDK alias has tracked files: ${JSON.stringify(files.slice(0, 8))}`);
    }
  }
}

async function checkForbiddenProductIdentityText() {
  const scanFiles = trackedFiles(
    'src',
    '.github',
    'tools/release',
    'Cargo.toml',
    'Package.swift',
    'package.json',
    'pnpm-workspace.yaml',
  );
  const offenders = [];
  for (const file of scanFiles) {
    if (file.startsWith('src/postgres/versions/18/')) {
      continue;
    }
    if (!existsSync(absolute(file))) {
      continue;
    }
    let text;
    try {
      text = await readText(file);
    } catch (error) {
      if (error instanceof TextDecodeFailure) {
        continue;
      }
      throw error;
    }
    const lowered = text.toLowerCase();
    for (const identity of FORBIDDEN_PRODUCT_IDENTITIES) {
      if (lowered.includes(identity)) {
        offenders.push(`${file}: contains ${identity}`);
      }
    }
  }
  if (offenders.length > 0) {
    fail(`forbidden product identity text found:\n${offenders.slice(0, 20).join('\n')}`);
  }
}

async function checkForbiddenRetiredReleaseToolText() {
  const scanFiles = trackedFiles(
    'src',
    '.github',
    'tools/release',
    'Cargo.toml',
    'Package.swift',
    'package.json',
    'pnpm-workspace.yaml',
    'release-please-config.json',
    '.release-please-manifest.json',
  );
  const offenders = [];
  for (const file of scanFiles) {
    if (file.startsWith('src/postgres/versions/18/')) {
      continue;
    }
    if (!existsSync(absolute(file))) {
      continue;
    }
    let text;
    try {
      text = await readText(file);
    } catch (error) {
      if (error instanceof TextDecodeFailure) {
        continue;
      }
      throw error;
    }
    const lowered = text.toLowerCase();
    for (const name of FORBIDDEN_RETIRED_RELEASE_TOOL_TEXT) {
      if (lowered.includes(name)) {
        offenders.push(`${file}: contains retired release tool reference ${name}`);
      }
    }
  }
  if (offenders.length > 0) {
    fail(`retired release tool text found on active product/release surfaces:\n${offenders.slice(0, 20).join('\n')}`);
  }
}

async function checkExtensionCatalogs() {
  const promotedRows = await extensionRows(PROMOTED_CATALOG);
  const smokeRows = await extensionRows(SMOKE_CATALOG);
  const promotedIds = promotedRows.map((row) => validateExtensionId(row.id, `${PROMOTED_CATALOG} row`));
  const smokeIds = smokeRows.map((row) => validateExtensionId(row.id, `${SMOKE_CATALOG} row`));
  validateUniqueIds(promotedIds, PROMOTED_CATALOG);
  validateUniqueIds(smokeIds, SMOKE_CATALOG);
  const promotedSet = new Set(promotedIds);
  const unknownSmoke = [...new Set(smokeIds)].filter((item) => !promotedSet.has(item)).sort(compareText);
  if (unknownSmoke.length > 0) {
    fail(`${SMOKE_CATALOG} references extensions not in promoted catalog: ${JSON.stringify(unknownSmoke)}`);
  }

  for (const row of promotedRows) {
    const unexpectedPackKeys = Object.keys(row)
      .filter((key) => key.includes('pack') || key.includes('bundle') || key.includes('alias'))
      .sort(compareText);
    if (unexpectedPackKeys.length > 0) {
      fail(`extension row ${row.id} must not use pack/bundle/alias keys: ${JSON.stringify(unexpectedPackKeys)}`);
    }
    if (row.stable === false && !pythonTruthy(row.blocker)) {
      fail(`candidate extension ${row.id} must explain its blocker`);
    }
  }
}

async function checkGeneratedExtensionMetadata() {
  const catalog = await readJson(GENERATED_CATALOG);
  const buildPlan = await readJson(GENERATED_BUILD_PLAN);
  const docsTable = await readJson(GENERATED_EXTENSION_DOCS);
  const evidenceTable = await readJson(GENERATED_EXTENSION_EVIDENCE);
  if (catalog['format-version'] !== 1) {
    fail(`${GENERATED_CATALOG} must use format-version 1`);
  }
  if (buildPlan['format-version'] !== 1) {
    fail(`${GENERATED_BUILD_PLAN} must use format-version 1`);
  }
  if (docsTable['format-version'] !== 1) {
    fail(`${GENERATED_EXTENSION_DOCS} must use format-version 1`);
  }
  if (evidenceTable['format-version'] !== 1) {
    fail(`${GENERATED_EXTENSION_EVIDENCE} must use format-version 1`);
  }
  for (const file of [...GENERATED_SDK_METADATA, GENERATED_MOBILE_REGISTRY, GENERATED_WASIX_METADATA]) {
    const value = await readJson(file);
    if (value['format-version'] !== 1) {
      fail(`${file} must use format-version 1`);
    }
  }
  for (const file of GENERATED_SDK_PACKAGE_METADATA) {
    requireFile(file);
  }

  const promotedIds = new Set(
    (await extensionRows(PROMOTED_CATALOG)).map((row) =>
      validateExtensionId(row.id, `${PROMOTED_CATALOG} row`),
    ),
  );
  const catalogExtensions = catalog.extensions;
  const buildExtensions = buildPlan.extensions;
  if (!Array.isArray(catalogExtensions) || catalogExtensions.length === 0) {
    fail(`${GENERATED_CATALOG} must define non-empty extensions`);
  }
  if (!Array.isArray(buildExtensions) || buildExtensions.length === 0) {
    fail(`${GENERATED_BUILD_PLAN} must define non-empty extensions`);
  }

  const catalogIds = catalogExtensions.map((row) => validateExtensionId(row.id, `${GENERATED_CATALOG} row`));
  const buildIds = buildExtensions.map((row) => validateExtensionId(row.id, `${GENERATED_BUILD_PLAN} row`));
  validateUniqueIds(catalogIds, GENERATED_CATALOG);
  validateUniqueIds(buildIds, GENERATED_BUILD_PLAN);
  const unknownCatalog = [...new Set(catalogIds)].filter((item) => !promotedIds.has(item)).sort(compareText);
  const unknownBuild = [...new Set(buildIds)].filter((item) => !promotedIds.has(item)).sort(compareText);
  if (unknownCatalog.length > 0) {
    fail(`${GENERATED_CATALOG} has ids not declared in promoted catalog: ${JSON.stringify(unknownCatalog)}`);
  }
  if (unknownBuild.length > 0) {
    fail(`${GENERATED_BUILD_PLAN} has ids not declared in promoted catalog: ${JSON.stringify(unknownBuild)}`);
  }

  for (const row of buildExtensions) {
    const extensionId = validateExtensionId(row.id, `${GENERATED_BUILD_PLAN} row`);
    const sqlName = validateSqlExtensionName(
      Object.hasOwn(row, 'sql-name') ? row['sql-name'] : extensionId,
      `${GENERATED_BUILD_PLAN} row`,
    );
    const buildKind = row['build-kind'];
    if (!new Set(['postgres-contrib', 'pgxs-external', 'pgxs-sql-only', 'autotools']).has(buildKind)) {
      fail(`${GENERATED_BUILD_PLAN} extension ${extensionId} has unsupported build-kind ${JSON.stringify(buildKind)}`);
    }
    if (buildKind === sqlName) {
      fail(`${GENERATED_BUILD_PLAN} extension ${extensionId} uses extension-specific build-kind ${JSON.stringify(buildKind)}; build-kind must be a reusable build family`);
    }
    const archive = row.archive;
    if (typeof archive !== 'string' || archive !== `extensions/${sqlName}.tar.zst`) {
      fail(`${GENERATED_BUILD_PLAN} extension ${extensionId} has invalid exact-extension archive ${JSON.stringify(archive)}`);
    }
    if (['pack', 'packs', 'bundle', 'alias', 'aliases'].some((key) => Object.hasOwn(row, key))) {
      fail(`${GENERATED_BUILD_PLAN} extension ${extensionId} must not use pack/bundle/alias metadata`);
    }
    if (buildKind === 'autotools') {
      const buildScript = row['build-script'];
      if (typeof buildScript !== 'string' || buildScript.length === 0) {
        fail(`${GENERATED_BUILD_PLAN} extension ${extensionId} must declare build-script for recipe-staged autotools builds`);
      }
      for (const field of ['required-build-files', 'required-build-globs']) {
        const values = row[field];
        if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value.length === 0)) {
          fail(`${GENERATED_BUILD_PLAN} extension ${extensionId} must declare non-empty ${field} for recipe-staged autotools builds`);
        }
      }
    }
  }

  for (const file of GENERATED_TSV) {
    requireFile(file);
    const text = await readText(file);
    if (text.toLowerCase().includes('pack') || text.toLowerCase().includes('bundle')) {
      fail(`${file} must not contain extension pack/bundle metadata`);
    }
  }
}

async function checkExtensionEvidence() {
  requireFile(EVIDENCE_MATRIX);
  requireFile(EVIDENCE_RUN_SCHEMA);
  requireFile(EVIDENCE_MATRIX_SCHEMA);
  requireDir(EVIDENCE_RUNS);
  if ((await readdir(absolute(EVIDENCE_RUNS))).filter((item) => item.endsWith('.json')).length === 0) {
    fail(`${EVIDENCE_RUNS} must contain extension evidence run files`);
  }

  const matrix = await readToml(EVIDENCE_MATRIX);
  if (matrix['format-version'] !== 1) {
    fail(`${EVIDENCE_MATRIX} must use format-version 1`);
  }
  const claims = matrix.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    fail(`${EVIDENCE_MATRIX} must declare [[claims]]`);
  }

  const publicIds = new Set(
    (await extensionRows(PROMOTED_CATALOG))
      .filter((row) => row.stable === true && row.build !== false)
      .map((row) => validateExtensionId(row.id, `${PROMOTED_CATALOG} row`)),
  );
  const claimIds = new Set(
    claims
      .filter((claim) => isRecord(claim) && claim.public === true)
      .map((claim) => validateExtensionId(claim.extension, `${EVIDENCE_MATRIX} claim`)),
  );
  const missing = [...publicIds].filter((item) => !claimIds.has(item)).sort(compareText);
  const extra = [...claimIds].filter((item) => !publicIds.has(item)).sort(compareText);
  if (missing.length > 0) {
    fail(`${EVIDENCE_MATRIX} is missing public claims for stable catalog rows: ${JSON.stringify(missing)}`);
  }
  if (extra.length > 0) {
    fail(`${EVIDENCE_MATRIX} claims public support for non-stable catalog rows: ${JSON.stringify(extra)}`);
  }
}

async function checkExtensionRecipes() {
  const retiredRecipesRoot = 'src/extensions/recipes';
  if (existsSync(absolute(retiredRecipesRoot))) {
    fail(`${retiredRecipesRoot} is retired; external extension definitions live under src/extensions/external`);
  }
  const externalRoot = 'src/extensions/external';
  if (!existsSync(absolute(externalRoot))) {
    fail(`${externalRoot} must exist`);
  }
  const entries = await readdir(absolute(externalRoot), { withFileTypes: true });
  const recipeFiles = entries
    .filter((entry) => entry.isDirectory() && existsSync(absolute(path.posix.join(externalRoot, entry.name, 'recipe.toml'))))
    .map((entry) => path.posix.join(externalRoot, entry.name, 'recipe.toml'))
    .sort(compareText);
  for (const recipe of recipeFiles) {
    const data = await readToml(recipe);
    if (data.schema !== 'oliphaunt-extension-recipe-v1') {
      fail(`${recipe} must use schema = oliphaunt-extension-recipe-v1`);
    }
    const sqlName = validateSqlExtensionName(data.sql_name, `${recipe} recipe`);
    const kind = data.kind;
    if (!new Set(['external-simple-pgxs', 'external-complex']).has(kind)) {
      fail(`${recipe} must declare an external recipe kind`);
    }
    if (path.posix.basename(path.posix.dirname(recipe)) !== sqlName) {
      fail(`${recipe} directory must match exact SQL extension name`);
    }
    for (const section of ['lifecycle', 'artifacts', 'support']) {
      if (!isRecord(data[section])) {
        fail(`${recipe} must declare [${section}]`);
      }
    }
    const recipeDir = path.posix.dirname(recipe);
    requireFile(path.posix.join(recipeDir, 'tests/smoke.sql'));
    const targets = path.posix.join(recipeDir, 'targets');
    const hasTargetToml =
      existsSync(absolute(targets)) &&
      statSync(absolute(targets)).isDirectory() &&
      (await readdir(absolute(targets))).some((item) => item.endsWith('.toml'));
    if (!hasTargetToml) {
      fail(`${recipe} must declare at least one target TOML under targets/`);
    }
    if (kind === 'external-complex') {
      requireFile(path.posix.join(recipeDir, 'deps.toml'));
      requireFile(path.posix.join(recipeDir, 'tests/upstream.toml'));
      requireFile(path.posix.join(recipeDir, 'patches/README.md'));
      requireFile(path.posix.join(recipeDir, 'blockers.toml'));
    }
  }
}

async function checkSdkLocalExtensionRules() {
  const catalogIds = new Set(
    (await extensionRows(PROMOTED_CATALOG)).map((row) =>
      validateExtensionId(row.id, `${PROMOTED_CATALOG} row`),
    ),
  );
  const complexIds = [...catalogIds].filter((item) =>
    new Set(['age', 'graph', 'pg_search', 'pg_textsearch', 'postgis', 'vector']).has(item),
  );
  const offenders = [];
  for (const file of trackedFiles('src/sdks/rust', 'src/sdks/swift', 'src/sdks/kotlin', 'src/sdks/react-native', 'src/sdks/js')) {
    if (!SDK_RUNTIME_SOURCE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      continue;
    }
    if (TRANSITIONAL_EXTENSION_RULE_FILES.has(file) || file.includes('/generated/')) {
      continue;
    }
    if (file.includes('/tests/') || file.includes('/Tests/') || file.includes('/__tests__/')) {
      continue;
    }
    let lines;
    try {
      lines = (await readText(file)).split(/\r?\n/u);
    } catch (error) {
      if (error instanceof TextDecodeFailure) {
        continue;
      }
      throw error;
    }
    for (const [index, line] of lines.entries()) {
      const stripped = line.trim();
      if (TRANSITIONAL_EXTENSION_RULE_ALLOWLIST.has(`${file}\0${stripped}`)) {
        continue;
      }
      for (const extensionId of complexIds) {
        const pattern = new RegExp(`['"\`](${escapeRegExp(extensionId)})['"\`]`, 'u');
        if (pattern.test(stripped)) {
          offenders.push(`${file}:${index + 1}: hardcodes extension ${JSON.stringify(extensionId)}: ${stripped}`);
        }
      }
    }
  }
  if (offenders.length > 0) {
    fail(`SDK runtime source must not hardcode complex extension rules outside generated metadata; known transitional exceptions must be explicit:\n${offenders.slice(0, 20).join('\n')}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function selfTest() {
  const expectFailure = (callback, label) => {
    let failedAsExpected = false;
    try {
      callback();
    } catch (error) {
      if (error instanceof PolicyFailure) {
        failedAsExpected = true;
      } else {
        throw error;
      }
    }
    if (!failedAsExpected) {
      fail(`self-test expected ${label} to fail`);
    }
  };
  expectFailure(() => validateExtensionId('bad-name', 'self-test'), 'invalid extension id');
  expectFailure(() => validateUniqueIds(['vector', 'vector'], 'self-test'), 'duplicate extension ids');
}

async function checkLiveRepo() {
  checkSourceDomains();
  await checkSourceSpinePolicy();
  await checkXtaskExtensionPolicy();
  await checkProductRoots();
  await checkForbiddenProductIdentityText();
  await checkForbiddenRetiredReleaseToolText();
  await checkExtensionCatalogs();
  await checkGeneratedExtensionMetadata();
  await checkExtensionEvidence();
  await checkExtensionRecipes();
  await checkSdkLocalExtensionRules();
}

function parseArgs(argv) {
  const args = { selfTest: false };
  for (const arg of argv) {
    if (arg === '--self-test') {
      args.selfTest = true;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(Bun.argv.slice(2));
try {
  if (args.selfTest) {
    selfTest();
  }
  await checkLiveRepo();
  console.log('final source architecture policy checks passed');
} catch (error) {
  if (error instanceof PolicyFailure) {
    console.error(`check-final-source-architecture.mjs: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
