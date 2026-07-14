#!/usr/bin/env bun
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(workspaceRoot);

const sourceCheckoutRoot = join(workspaceRoot, 'target', 'oliphaunt-sources', 'checkouts');
const sourceArchiveRoot = join(workspaceRoot, 'target', 'oliphaunt-sources', 'archives');
const sourceOrigins = {
  sharedThirdParty: 'shared-third-party',
  nativeThirdParty: 'native-third-party',
  wasixThirdParty: 'wasix-third-party',
  extension: 'extension',
};
const allowedScopes = new Set(['all', 'native-runtime', 'wasix-runtime', 'extensions']);

const {scope, force} = parseArgs(process.argv.slice(2));
if (!allowedScopes.has(scope)) {
  fail(`unsupported source fetch scope '${scope}'; expected one of: ${[...allowedScopes].join(', ')}`, 2);
}

if (!force && process.env.CI !== 'true' && process.env.OLIPHAUNT_FETCH_SOURCES !== '1') {
  console.log(
    `source checkout fetch skipped outside CI for scope '${scope}'; set OLIPHAUNT_FETCH_SOURCES=1 or pass --force to refresh pinned checkouts with Bun`,
  );
  process.exit(0);
}

try {
  const manifest = loadSourcesManifest(scope);
  validateSourcesManifest(manifest, scope);
  await fetchManifestSources(manifest, scope);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function parseArgs(args) {
  let selectedScope = 'all';
  let sawScope = false;
  let forceFetch = false;
  for (const arg of args) {
    if (arg === '--force') {
      forceFetch = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('usage: bun tools/policy/fetch-sources.mjs [all|native-runtime|wasix-runtime|extensions] [--force]');
      process.exit(0);
    }
    if (sawScope) {
      fail(`unexpected argument '${arg}'`, 2);
    }
    selectedScope = arg;
    sawScope = true;
  }
  return {scope: selectedScope, force: forceFetch};
}

function loadSourcesManifest(selectedScope) {
  const sources = [];
  const names = new Set();
  const thirdPartyRoot = join(workspaceRoot, 'src', 'sources', 'third-party');
  for (const [domain, origin] of sourceDomainsForScope(selectedScope)) {
    const domainDir = join(thirdPartyRoot, domain);
    if (!existsSync(domainDir)) {
      continue;
    }
    for (const file of readdirSync(domainDir).sort()) {
      if (!file.endsWith('.toml')) {
        continue;
      }
      pushSourcePin(sources, names, join(domainDir, file), origin);
    }
  }
  for (const sourcePath of extensionSourcePinPaths()) {
    pushSourcePin(sources, names, sourcePath, sourceOrigins.extension);
  }
  return {sources, ...(scopeIncludesWasix(selectedScope) ? readToml('src/sources/toolchains/wasix.toml') : {})};
}

function sourceDomainsForScope(selectedScope) {
  const domains = [];
  if (selectedScope === 'all' || selectedScope === 'native-runtime' || selectedScope === 'wasix-runtime') {
    domains.push(['shared', sourceOrigins.sharedThirdParty]);
  }
  if (selectedScope === 'all' || selectedScope === 'native-runtime') {
    domains.push(['native', sourceOrigins.nativeThirdParty]);
  }
  if (selectedScope === 'all' || selectedScope === 'wasix-runtime') {
    domains.push(['wasix', sourceOrigins.wasixThirdParty]);
  }
  return domains;
}

function scopeIncludesWasix(selectedScope) {
  return selectedScope === 'all' || selectedScope === 'wasix-runtime';
}

function extensionSourcePinPaths() {
  const root = join(workspaceRoot, 'src', 'extensions', 'external');
  const paths = [];
  collectSourcePins(root, paths);
  return paths.sort();
}

function collectSourcePins(dir, paths) {
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir, {withFileTypes: true}).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourcePins(path, paths);
    } else if (entry.name === 'source.toml') {
      paths.push(path);
    }
  }
}

function pushSourcePin(sources, names, path, origin) {
  const raw = readToml(path);
  const source = {
    name: stringField(raw, 'name', path),
    kind: raw.kind ?? 'git',
    url: stringField(raw, 'url', path),
    branch: stringField(raw, 'branch', path),
    commit: stringField(raw, 'commit', path),
    sha256: optionalStringField(raw, 'sha256', path),
    stripPrefix: optionalStringField(raw, 'strip_prefix', path) ?? optionalStringField(raw, 'strip-prefix', path),
    origin,
  };
  if (names.has(source.name)) {
    throw new Error(`duplicate source pin '${source.name}' in source metadata`);
  }
  names.add(source.name);
  sources.push(source);
}

function readToml(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return Bun.TOML.parse(text);
  } catch (error) {
    throw new Error(`parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringField(object, field, path) {
  const value = object[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path} must set non-empty string field '${field}'`);
  }
  return value;
}

function optionalStringField(object, field, path) {
  const value = object[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${path} field '${field}' must be a string`);
  }
  return value;
}

function validateSourcesManifest(manifest, selectedScope) {
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    throw new Error('source metadata must contain at least one source pin');
  }
  if (scopeIncludesWasix(selectedScope)) {
    validateWasixToolchain(manifest);
  }
  for (const source of manifest.sources) {
    validateSourcePin(source);
  }
}

function validateWasixToolchain(manifest) {
  assertEquals(manifest.toolchain?.wasmer, '7.2.0', 'toolchain.wasmer');
  assertEquals(manifest.toolchain?.['wasmer-wasix'], '0.702.0', 'toolchain.wasmer-wasix');
  const digest = manifest.toolchain?.docker_image_digest;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-fA-F]{64}$/.test(digest)) {
    throw new Error(`toolchain.docker_image_digest must pin a concrete sha256 digest, got ${digest}`);
  }
  const dockerfile = readFileSync(
    join(workspaceRoot, 'src', 'runtimes', 'liboliphaunt', 'wasix', 'assets', 'build', 'docker', 'Dockerfile'),
    'utf8',
  );
  if (!dockerfile.includes(`FROM ubuntu:24.04@${digest}`)) {
    throw new Error(
      'WASIX build Dockerfile must pin the same base image digest as src/sources/toolchains/wasix.toml',
    );
  }
  assertEquals(manifest.build?.postgres_prefix, '/', 'build.postgres_prefix');
  assertEquals(manifest.build?.postgres_pkglibdir, '/lib/postgresql', 'build.postgres_pkglibdir');
  assertEquals(manifest.build?.postgres_sharedir, '/share/postgresql', 'build.postgres_sharedir');
  assertIncludes(manifest.build?.main_flags, '-fwasm-exceptions', 'build.main_flags');
  assertNoFlagContains(manifest.build?.main_flags, 'asyncify', 'build.main_flags');
  assertIncludes(manifest.build?.extension_flags, '-fwasm-exceptions', 'build.extension_flags');
  assertNoFlagContains(manifest.build?.extension_flags, 'asyncify', 'build.extension_flags');
  assertIncludes(manifest.build?.extension_flags, '-fPIC', 'build.extension_flags');
  assertIncludes(manifest.build?.extension_flags, '-Wl,-shared', 'build.extension_flags');
  assertEquals(manifest.build?.archive_format, 'tar.zst', 'build.archive_format');
  if (manifest.build?.deterministic_archives !== true) {
    throw new Error('build.deterministic_archives must be true');
  }
}

function validateSourcePin(source) {
  if (!validSourceNameComponent(source.name) || source.url.trim() === '' || source.branch.trim() === '') {
    throw new Error(`invalid source pin in source metadata: ${JSON.stringify(source)}`);
  }
  if (source.commit.length < 40) {
    throw new Error(`source '${source.name}' commit must be a full pinned revision`);
  }
  if (!['git', 'archive'].includes(source.kind)) {
    throw new Error(`source '${source.name}' has unsupported kind '${source.kind}'`);
  }
  if (source.kind === 'git') {
    if (source.sha256 !== undefined || source.stripPrefix !== undefined) {
      throw new Error(`git source '${source.name}' must not set sha256 or strip-prefix`);
    }
    return;
  }
  const sha256 = archiveSha256(source);
  archiveStripPrefix(source);
  assertEquals(source.commit, sha256, `${source.name} archive commit must equal archive sha256`);
  if (!source.url.endsWith('.tar.gz') && !source.url.endsWith('.tgz')) {
    throw new Error(`archive source '${source.name}' must point at a .tar.gz or .tgz URL`);
  }
}

async function fetchManifestSources(manifest, selectedScope) {
  for (const source of manifest.sources) {
    if (!scopeIncludes(selectedScope, source.origin)) {
      console.error(`skipping source '${source.name}' for selected source lane`);
      continue;
    }
    const checkoutPath = sourceCheckoutPath(source.name);
    if (checkoutPath === undefined) {
      console.error(`warning: source '${source.name}' has no configured checkout path; skipping fetch`);
      continue;
    }
    if (source.kind === 'archive') {
      fetchArchiveSource(source, checkoutPath);
      continue;
    }
    if (!existsSync(checkoutPath) || !existsSync(join(checkoutPath, '.git'))) {
      initSourceCheckout(source, checkoutPath);
    }
    ensureCleanCheckout(source, checkoutPath);
    ensureSourceRemote(source, checkoutPath);
    await fetchGitSourceWithRetries(source, checkoutPath);
    run('git', ['checkout', '-B', source.branch, source.commit], {
      cwd: checkoutPath,
      label: `checkout ${source.name} at ${source.commit} in ${checkoutPath}`,
    });
  }
}

function scopeIncludes(selectedScope, origin) {
  if (selectedScope === 'all') {
    return true;
  }
  if (selectedScope === 'native-runtime') {
    return [
      sourceOrigins.sharedThirdParty,
      sourceOrigins.nativeThirdParty,
      sourceOrigins.extension,
    ].includes(origin);
  }
  if (selectedScope === 'wasix-runtime') {
    return [
      sourceOrigins.sharedThirdParty,
      sourceOrigins.wasixThirdParty,
      sourceOrigins.extension,
    ].includes(origin);
  }
  return origin === sourceOrigins.extension;
}

function initSourceCheckout(source, path) {
  if (existsSync(path) && !existsSync(join(path, '.git'))) {
    if (readdirSync(path).length === 0) {
      rmSync(path, {recursive: true, force: true});
    } else {
      throw new Error(`source checkout path ${path} exists but is not a git checkout; remove it or move it aside`);
    }
  }
  mkdirSync(dirname(path), {recursive: true});
  run('git', ['init', path], {label: `initialize source checkout ${path}`});
  ensureSourceRemote(source, path);
}

function ensureSourceRemote(source, path) {
  const remotes = commandOutput('git', ['remote'], path);
  const args = remotes.split(/\r?\n/).includes('origin')
    ? ['remote', 'set-url', 'origin', source.url]
    : ['remote', 'add', 'origin', source.url];
  run('git', args, {cwd: path, label: `configure origin remote for ${source.name} at ${path}`});
}

async function fetchGitSourceWithRetries(source, path) {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run('git', ['fetch', '--no-tags', '--depth', '1', 'origin', source.commit], {
        cwd: path,
        label: `fetch ${source.name}`,
      });
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw error;
      }
      const delaySeconds = attempt * 5;
      console.error(
        `fetch ${source.name} failed on attempt ${attempt}/${attempts}: ${
          error instanceof Error ? error.message : String(error)
        }; retrying in ${delaySeconds}s`,
      );
      await Bun.sleep(delaySeconds * 1000);
    }
  }
}

function fetchArchiveSource(source, path) {
  if (archiveSourceReady(source, path)) {
    return;
  }
  if (existsSync(path)) {
    if (existsSync(join(path, '.git'))) {
      const status = sourceCheckoutStatusForSource(source, path);
      if (status.trim() !== '') {
        throw new Error(
          `archive source path ${path} (${source.name}) is a dirty git checkout; preserve it before replacing it with an archive source`,
        );
      }
    }
    rmSync(path, {recursive: true, force: true});
  }
  const archive = fetchSourceArchive(source);
  const extractRoot = join(dirname(path), `.${source.name}-extracting`);
  rmSync(extractRoot, {recursive: true, force: true});
  mkdirSync(extractRoot, {recursive: true});
  run('tar', ['-xzf', commandPath(archive), '-C', commandPath(extractRoot)], {label: `extract ${archive}`});
  const extracted = join(extractRoot, archiveStripPrefix(source));
  if (!isDirectory(extracted)) {
    throw new Error(`archive source '${source.name}' did not contain expected root ${extracted}`);
  }
  mkdirSync(dirname(path), {recursive: true});
  renameSync(extracted, path);
  rmSync(extractRoot, {recursive: true, force: true});
  writeFileSync(archiveSourceStampPath(path), archiveStamp(source));
}

function fetchSourceArchive(source) {
  const sha256 = archiveSha256(source);
  mkdirSync(sourceArchiveRoot, {recursive: true});
  const archive = join(sourceArchiveRoot, `${source.name}-${sha256}.tar.gz`);
  if (existsSync(archive)) {
    const actual = sha256File(archive);
    if (actual === sha256) {
      return archive;
    }
    rmSync(archive, {force: true});
  }
  const tmpArchive = `${archive}.tmp`;
  rmSync(tmpArchive, {force: true});
  run(
    'curl',
    [
      '--fail',
      '--location',
      '--silent',
      '--show-error',
      '--retry',
      '8',
      '--retry-all-errors',
      '--retry-delay',
      '5',
      '--connect-timeout',
      '20',
      source.url,
      '-o',
      tmpArchive,
    ],
    {label: `download ${source.name}`},
  );
  assertEquals(sha256File(tmpArchive), sha256, `${source.name} archive sha256`);
  renameSync(tmpArchive, archive);
  return archive;
}

function archiveSourceReady(source, path) {
  const stampPath = archiveSourceStampPath(path);
  return isDirectory(path) && existsSync(stampPath) && readFileSync(stampPath, 'utf8') === archiveStamp(source);
}

function archiveSourceStampPath(path) {
  return join(path, '.oliphaunt-source-pin');
}

function archiveStamp(source) {
  return `name=${source.name}\nkind=archive\nurl=${source.url}\nbranch=${source.branch}\ncommit=${source.commit}\nsha256=${
    source.sha256 ?? ''
  }\nstrip-prefix=${source.stripPrefix ?? ''}\n`;
}

function archiveSha256(source) {
  if (source.sha256 === undefined || !/^[0-9a-fA-F]{64}$/.test(source.sha256)) {
    throw new Error(`archive source '${source.name}' has invalid sha256 ${source.sha256}`);
  }
  return source.sha256;
}

function archiveStripPrefix(source) {
  if (
    source.stripPrefix === undefined ||
    source.stripPrefix === '' ||
    source.stripPrefix.includes('..') ||
    source.stripPrefix.startsWith('/')
  ) {
    throw new Error(`archive source '${source.name}' has invalid strip-prefix`);
  }
  return source.stripPrefix;
}

function sourceCheckoutPath(name) {
  return validSourceNameComponent(name) ? join(sourceCheckoutRoot, name) : undefined;
}

function validSourceNameComponent(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    !name.includes('..') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

function ensureCleanCheckout(source, path) {
  if (!existsSync(path)) {
    throw new Error(`source checkout is missing: ${path}`);
  }
  const status = sourceCheckoutStatusForSource(source, path);
  if (status.trim() !== '') {
    throw new Error(`source checkout ${path} (${source.name}) has uncommitted changes; preserve them before fetching pins`);
  }
}

function sourceCheckoutStatusForSource(source, path) {
  return commandOutput('git', ['status', '--porcelain'], path, `read status for ${path} (${source.name})`);
}

function commandOutput(command, args, cwd, label = `${command} ${args.join(' ')}`) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error !== undefined) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}: ${result.stderr.trim() || `exit code ${result.status}`}`);
  }
  return result.stdout;
}

function run(command, args, {cwd = workspaceRoot, label = `${command} ${args.join(' ')}`} = {}) {
  const result = spawnSync(command, args, {cwd, stdio: 'inherit'});
  if (result.error !== undefined) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label}: exit code ${result.status}`);
  }
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function commandPath(path) {
  const relativePath = relative(workspaceRoot, resolve(path));
  if (!relativePath.startsWith('..') && !relativePath.includes(':')) {
    return relativePath.split(sep).join('/');
  }
  return path.split(sep).join('/');
}

function assertEquals(actual, expected, name) {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(values, expected, name) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    throw new Error(`${name} must contain ${expected}`);
  }
}

function assertNoFlagContains(values, needle, name) {
  if (!Array.isArray(values)) {
    throw new Error(`${name} must be an array`);
  }
  if (values.some((value) => typeof value === 'string' && value.includes(needle))) {
    throw new Error(`${name} must not contain ${needle}`);
  }
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
