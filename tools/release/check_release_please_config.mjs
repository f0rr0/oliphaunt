#!/usr/bin/env bun
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(root, 'release-please-config.json');
const manifestPath = path.join(root, '.release-please-manifest.json');
const decoder = new TextDecoder();
const RELEASE_PR_TITLE_PATTERN = 'chore${scope}: release${component} ${version}';
const GROUP_RELEASE_PR_TITLE_PATTERN = 'chore(release): prepare ${branch} releases';

function fail(message) {
  console.error(`check_release_please_config.mjs: ${message}`);
  process.exit(2);
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

async function readJson(file) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    fail(`failed to read ${rel(file)}: ${error.message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${rel(file)} must contain a JSON object`);
  }
  return value;
}

async function requireFile(file, context) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) {
      return;
    }
  } catch {
    // handled below
  }
  fail(`${context} references missing file ${rel(file)}`);
}

function rejectUnsafeRelativePath(value, context) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).includes('..')
  ) {
    fail(`${context} must stay inside its release-please package path: ${JSON.stringify(value)}`);
  }
}

function parseStableVersion(value, context) {
  const match = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)$/u.exec(value);
  if (!match) {
    fail(`${context} must be a stable semver version, got ${JSON.stringify(value)}`);
  }
  return match.slice(1).map((part) => Number(part));
}

function compareStableVersion(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function validateSwiftReleasePleaseBootstrap(packagePath, packageConfig, manifestVersion) {
  if (packageConfig['bump-patch-for-minor-pre-major'] !== false) {
    fail(
      `${packagePath}.bump-patch-for-minor-pre-major must be false so SwiftPM feature releases move past legacy unscoped semver tags`,
    );
  }

  const current = parseStableVersion(manifestVersion, `${packagePath} manifest version`);
  const bootstrapBaseline = parseStableVersion('0.5.0', 'SwiftPM bootstrap baseline');
  const firstPublicVersion = parseStableVersion('0.6.0', 'SwiftPM first public version');
  if (compareStableVersion(current, bootstrapBaseline) < 0) {
    fail(`${packagePath} must not bootstrap below the legacy SwiftPM-safe baseline 0.5.0`);
  }
  if (
    compareStableVersion(current, bootstrapBaseline) > 0 &&
    compareStableVersion(current, firstPublicVersion) < 0
  ) {
    fail(
      `${packagePath} version ${JSON.stringify(
        manifestVersion,
      )} is below the first safe Oliphaunt SwiftPM version 0.6.0`,
    );
  }
}

function moonBin() {
  if (process.env.MOON_BIN) {
    return process.env.MOON_BIN;
  }
  const protoBin = path.join(process.env.HOME ?? '', '.proto/bin/moon');
  return Bun.file(protoBin).exists() ? protoBin : 'moon';
}

function runMoonProjects() {
  const result = Bun.spawnSync([moonBin(), 'query', 'projects'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    const stderr = decoder.decode(result.stderr).trim();
    fail(`moon query projects failed${stderr ? `: ${stderr}` : ''}`);
  }
  const value = JSON.parse(decoder.decode(result.stdout));
  if (!Array.isArray(value.projects)) {
    fail('moon query projects did not return a projects array');
  }
  return value.projects;
}

function moonReleaseProducts() {
  const products = new Map();
  for (const project of runMoonProjects()) {
    const projectId = project?.id;
    const config = project?.config ?? {};
    const tags = Array.isArray(config.tags) ? config.tags : [];
    const release = config.project?.metadata?.release;
    if (!tags.includes('release-product')) {
      if (release !== undefined) {
        fail(`Moon project ${projectId} declares release metadata but is not tagged release-product`);
      }
      continue;
    }
    if (typeof projectId !== 'string' || !projectId) {
      fail('Moon release product must have a project id');
    }
    if (typeof release !== 'object' || release === null || Array.isArray(release)) {
      fail(`Moon release product ${projectId} must declare project.metadata.release`);
    }
    const component = release.component;
    const packagePath = release.packagePath;
    if (component !== projectId) {
      fail(`Moon release product ${projectId} release.component must match the project id`);
    }
    if (typeof packagePath !== 'string' || !packagePath) {
      fail(`Moon release product ${projectId} must declare release.packagePath`);
    }
    rejectUnsafeRelativePath(packagePath, `${projectId}.release.packagePath`);
    if (products.has(component)) {
      fail(`duplicate Moon release component ${component}`);
    }
    products.set(component, packagePath);
  }
  if (products.size === 0) {
    fail('Moon project graph does not contain any release-product projects');
  }
  return products;
}

function parseCargoVersion(text) {
  let inPackage = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '[package]') {
      inPackage = true;
      continue;
    }
    if (inPackage && line.startsWith('[')) {
      break;
    }
    if (!inPackage) {
      continue;
    }
    const match = line.match(/^version\s*=\s*"([^"]+)"/u);
    if (match) {
      return match[1];
    }
  }
  return '';
}

function canonicalVersionFile(packagePath, packageConfig, product) {
  const versionFile = packageConfig['version-file'];
  if (versionFile !== undefined) {
    if (typeof versionFile !== 'string' || !versionFile) {
      fail(`${packagePath}.version-file must be a non-empty string`);
    }
    rejectUnsafeRelativePath(versionFile, `${packagePath}.version-file`);
    return versionFile;
  }
  const releaseType = packageConfig['release-type'];
  if (releaseType === 'rust') {
    return 'Cargo.toml';
  }
  if (releaseType === 'node' || releaseType === 'expo') {
    return 'package.json';
  }
  fail(`${product} release-please config must declare version-file for release type ${JSON.stringify(releaseType)}`);
}

async function currentVersion(product, packagePath, packageConfig) {
  const versionFile = canonicalVersionFile(packagePath, packageConfig, product);
  const file = path.join(root, packagePath, versionFile);
  await requireFile(file, `${packagePath}.version-file`);
  const text = await fs.readFile(file, 'utf8');
  const name = path.basename(versionFile);
  let version = '';
  if (name === 'Cargo.toml') {
    version = parseCargoVersion(text);
  } else if (name === 'package.json') {
    const data = JSON.parse(text);
    version = typeof data.version === 'string' ? data.version : '';
  } else if (name === 'VERSION' || name === 'LIBOLIPHAUNT_VERSION') {
    version = text.trim();
  } else {
    fail(`${product}.version-file has unsupported version file type: ${versionFile}`);
  }
  if (!version) {
    fail(`${rel(file)} does not define a release version for ${product}`);
  }
  return version;
}

async function validateExtraFiles(packagePath, packageConfig) {
  const extraFiles = packageConfig['extra-files'] ?? [];
  if (!Array.isArray(extraFiles)) {
    fail(`${packagePath}.extra-files must be a list`);
  }
  for (const [index, entry] of extraFiles.entries()) {
    const context = `${packagePath}.extra-files[${index}]`;
    if (typeof entry === 'string') {
      rejectUnsafeRelativePath(entry, context);
      await requireFile(path.join(root, packagePath, entry), context);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`${context} must be a path string or object`);
    }
    const entryPath = entry.path;
    if (typeof entryPath !== 'string' || !entryPath) {
      fail(`${context}.path must be a non-empty string`);
    }
    rejectUnsafeRelativePath(entryPath, `${context}.path`);
    await requireFile(path.join(root, packagePath, entryPath), context);
    const entryType = entry.type;
    if (['json', 'toml', 'yaml'].includes(entryType) && typeof entry.jsonpath !== 'string') {
      fail(`${context} type ${JSON.stringify(entryType)} requires jsonpath`);
    }
    if (entryType === 'xml' && typeof entry.xpath !== 'string') {
      fail(`${context} type 'xml' requires xpath`);
    }
  }
}

const config = await readJson(configPath);
const manifest = await readJson(manifestPath);
const packages = config.packages;
if (typeof packages !== 'object' || packages === null || Array.isArray(packages) || Object.keys(packages).length === 0) {
  fail('release-please-config.json must define non-empty packages');
}

const pathsById = moonReleaseProducts();
const expectedPaths = new Set(pathsById.values());
const actualPaths = new Set(Object.keys(packages));
const manifestPaths = new Set(Object.keys(manifest));
const sortedDifference = (left, right) => [...left].filter((item) => !right.has(item)).sort();
function expectedRuntimeLinkedComponents(pathsById) {
  const runtimes = ['liboliphaunt-native', 'liboliphaunt-wasix'];
  for (const runtime of runtimes) {
    if (!pathsById.has(runtime)) {
      fail(`release-please runtime linked-version group is missing ${runtime}`);
    }
  }
  const contribExtensions = [...pathsById.entries()]
    .filter(([component, packagePath]) => component.startsWith('oliphaunt-extension-') && packagePath.startsWith('src/extensions/contrib/'))
    .map(([component]) => component)
    .sort();
  return [...runtimes, ...contribExtensions];
}

function validatePlugins(plugins, pathsById) {
  if (!Array.isArray(plugins)) {
    fail('release-please plugins must be a list');
  }
  const expected = [
    {
      type: 'node-workspace',
      merge: false,
    },
    {
      type: 'linked-versions',
      groupName: 'liboliphaunt-runtime',
      components: expectedRuntimeLinkedComponents(pathsById),
    },
  ];
  if (JSON.stringify(plugins) !== JSON.stringify(expected)) {
    fail(
      'release-please plugins must use node-workspace without internal merging plus a linked-versions group for liboliphaunt-native, liboliphaunt-wasix, and contrib extensions',
    );
  }
}

function releasePleaseTitlePatternRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern) {
    fail(`release-please title pattern must be a non-empty string: ${JSON.stringify(pattern)}`);
  }
  return new RegExp(
    `^${pattern
      .replace('[', '\\[')
      .replace(']', '\\]')
      .replace('(', '\\(')
      .replace(')', '\\)')
      .replace('${scope}', '(\\((?<branch>[\\w-./]+)\\))?')
      .replace('${component}', ' ?(?<component>@?[\\w-./]*)?')
      .replace('${version}', 'v?(?<version>[0-9].*)')
      .replace('${branch}', '(?<branch>[\\w-./]+)?')}$`,
  );
}

function assertParseableReleasePleaseTitle(pattern, title, context) {
  const match = title.match(releasePleaseTitlePatternRegex(pattern));
  if (!match?.groups) {
    fail(`${context} must be parseable by release-please: ${JSON.stringify(title)}`);
  }
}

function renderReleasePleaseTitle(pattern, { targetBranch }) {
  return pattern
    .replace('${scope}', targetBranch ? `(${targetBranch})` : '')
    .replace('${component}', '')
    .replace('${version}', '')
    .replace('${branch}', targetBranch ?? '')
    .trim();
}
if (actualPaths.size !== expectedPaths.size || sortedDifference(expectedPaths, actualPaths).length > 0) {
  fail(
    `release-please packages must match release products:\nmissing=${JSON.stringify(sortedDifference(expectedPaths, actualPaths))}\nextra=${JSON.stringify(sortedDifference(actualPaths, expectedPaths))}`,
  );
}
if (manifestPaths.size !== expectedPaths.size || sortedDifference(expectedPaths, manifestPaths).length > 0) {
  fail(
    `.release-please-manifest.json paths must match release products:\nmissing=${JSON.stringify(sortedDifference(expectedPaths, manifestPaths))}\nextra=${JSON.stringify(sortedDifference(manifestPaths, expectedPaths))}`,
  );
}

if (config['tag-separator'] !== '-') {
  fail("release-please tag-separator must be '-' for <component>-v<version> tags");
}
if (config['include-v-in-tag'] !== true) {
  fail('release-please must include v in tags');
}
if (config['pull-request-title-pattern'] !== RELEASE_PR_TITLE_PATTERN) {
  fail("release-please pull-request-title-pattern must keep release-please's parseable default shape");
}
if (config['group-pull-request-title-pattern'] !== GROUP_RELEASE_PR_TITLE_PATTERN) {
  fail('release-please group-pull-request-title-pattern must keep grouped release PRs parseable');
}
const generatedGroupTitle = renderReleasePleaseTitle(GROUP_RELEASE_PR_TITLE_PATTERN, { targetBranch: 'main' });
if (generatedGroupTitle !== 'chore(release): prepare main releases') {
  fail(`release-please grouped release PR title rendered unexpectedly: ${JSON.stringify(generatedGroupTitle)}`);
}
assertParseableReleasePleaseTitle(
  GROUP_RELEASE_PR_TITLE_PATTERN,
  generatedGroupTitle,
  'generated grouped release PR title',
);
assertParseableReleasePleaseTitle(
  GROUP_RELEASE_PR_TITLE_PATTERN,
  'chore(release): prepare product releases',
  'already-merged grouped release PR #80 title',
);
if (config['initial-version'] !== '0.1.0') {
  fail('release-please initial-version must bootstrap the first generated release PR to 0.1.0');
}
if (config['bump-minor-pre-major'] !== true) {
  fail('release-please must minor-bump breaking changes while product versions are below 1.0.0');
}
if (config['bump-patch-for-minor-pre-major'] !== true) {
  fail('release-please must patch-bump feat commits after the 0.1.0 bootstrap while versions stay below 1.0.0');
}
validatePlugins(config.plugins ?? [], pathsById);

const idsByPath = new Map([...pathsById.entries()].map(([product, packagePath]) => [packagePath, product]));
for (const [packagePath, packageConfig] of Object.entries(packages)) {
  if (typeof packageConfig !== 'object' || packageConfig === null || Array.isArray(packageConfig)) {
    fail(`${packagePath} config must be an object`);
  }
  const product = idsByPath.get(packagePath);
  const component = packageConfig.component;
  if (component !== product) {
    fail(`${packagePath}.component must be ${JSON.stringify(product)}, got ${JSON.stringify(component)}`);
  }
  const tagPrefix = `${component}-v`;
  if (tagPrefix !== `${product}-v`) {
    fail(`${product} release-please component does not match tag prefix ${JSON.stringify(tagPrefix)}`);
  }
  const manifestVersion = manifest[packagePath];
  const version = await currentVersion(product, packagePath, packageConfig);
  if (manifestVersion !== version) {
    fail(`${packagePath} manifest version ${JSON.stringify(manifestVersion)} does not match current ${product} version ${JSON.stringify(version)}`);
  }
  if (product === 'oliphaunt-swift') {
    validateSwiftReleasePleaseBootstrap(packagePath, packageConfig, manifestVersion);
  }
  const changelogPath = packageConfig['changelog-path'] ?? 'CHANGELOG.md';
  if (typeof changelogPath !== 'string' || !changelogPath) {
    fail(`${packagePath}.changelog-path must be a non-empty string`);
  }
  rejectUnsafeRelativePath(changelogPath, `${packagePath}.changelog-path`);
  await requireFile(path.join(root, packagePath, changelogPath), `${packagePath}.changelog-path`);
  await validateExtraFiles(packagePath, packageConfig);
}

console.log('release-please config checks passed');
