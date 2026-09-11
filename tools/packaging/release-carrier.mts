import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, artifactTargets, compareText } from '../release/release-artifact-targets.mts';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { readPortableArchiveEntries } from './portable-archive.mts';
import { packGeneratedNpmCarrier } from './npm-package.mts';
import { validateNpmTrustedPublishingManifest } from './npm-trusted-publishing.mts';
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  parseWindowsVcRuntimeReceipt,
  windowsVcRuntimeProfileNames,
} from './windows-vc-runtime-closure.mts';

export const TOOL = 'package-release-carriers.mts';

export function fail(message, exitCode = 1) {
  console.error(`${TOOL}: ${message}`);
  process.exit(exitCode);
}

export function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sortedStrings(values) {
  return [...values].sort(compareText);
}

export function assertSameStringSet(label, actual, expected) {
  const actualSorted = sortedStrings(actual);
  const expectedSorted = sortedStrings(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `${label}: expected=${JSON.stringify(expectedSorted)}, actual=${JSON.stringify(actualSorted)}`,
    );
  }
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function stagedRuntimeInputDirs(envName) {
  const raw = process.env[envName] ?? process.env.OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS ?? '';
  return raw
    .split(path.delimiter)
    .filter(Boolean)
    .map((item) => {
      const expanded =
        item === '~' || item.startsWith('~/')
          ? path.join(process.env.HOME ?? '', item.slice(1))
          : item;
      return path.isAbsolute(expanded) ? expanded : path.join(ROOT, expanded);
    });
}

function globRegex(pattern) {
  return new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'u');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function copyStagedRuntimeAssets({ product, destination, envName, patterns }) {
  const sourceDirs = stagedRuntimeInputDirs(envName);
  if (sourceDirs.length === 0) {
    fail(
      `${product} requires staged runtime artifacts; set ${envName} or OLIPHAUNT_RELEASE_ASSET_INPUT_DIRS to the downloaded CI artifact directory`,
    );
  }
  mkdirSync(destination, { recursive: true });
  const regexes = patterns.map(globRegex);
  let copied = 0;
  for (const sourceDir of sourceDirs) {
    if (!isDirectory(sourceDir)) {
      fail(`${product} release asset input directory does not exist: ${sourceDir}`);
    }
    for (const name of readdirSync(sourceDir).sort(compareText)) {
      if (!regexes.some((regex) => regex.test(name))) {
        continue;
      }
      const source = path.join(sourceDir, name);
      if (!isFile(source)) {
        continue;
      }
      const output = path.join(destination, name);
      if (isFile(output)) {
        if (sha256File(output) !== sha256File(source)) {
          fail(
            `${product} release asset input collision for ${name}: ${rel(output)} and ${rel(source)} have different bytes`,
          );
        }
        continue;
      }
      copyFileSync(source, output);
      copied += 1;
    }
  }
  if (copied === 0) {
    fail(
      `${product} found no staged runtime artifacts matching ${JSON.stringify(patterns)} under ${JSON.stringify(sourceDirs)}`,
    );
  }
}

function npmPackageDirsUnder(packageRoot) {
  const packages = new Map();
  if (!isDirectory(packageRoot)) {
    fail(`${rel(packageRoot)} does not contain npm package descriptors`);
  }
  for (const packageDirName of readdirSync(packageRoot).sort(compareText)) {
    const packageDir = path.join(packageRoot, packageDirName);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!isFile(packageJsonPath)) {
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
      fail(`${rel(packageJsonPath)} is not valid JSON: ${error.message}`);
    }
    const packageName = packageJson.name;
    if (typeof packageName !== 'string' || packageName.length === 0) {
      fail(`${rel(packageJsonPath)} must declare name`);
    }
    if (packages.has(packageName)) {
      fail(
        `duplicate npm package name ${packageName} in ${rel(packages.get(packageName))} and ${rel(packageDir)}`,
      );
    }
    packages.set(packageName, packageDir);
  }
  if (packages.size === 0) {
    fail(`${rel(packageRoot)} does not contain npm package descriptors`);
  }
  return packages;
}

export function artifactNpmPackageTargets({ product, kind, surface, packageRoot, version }) {
  const packageDirs = npmPackageDirsUnder(packageRoot);
  const packages = [];
  for (const target of artifactTargets(product, kind, TOOL).filter((candidate) =>
    candidate.surfaces.includes(surface),
  )) {
    const packageName = target.npm_package;
    if (typeof packageName !== 'string' || packageName.length === 0) {
      fail(`${target.id} must declare npm_package for npm artifact package publication`);
    }
    const packageDir = packageDirs.get(packageName);
    if (packageDir === undefined) {
      fail(`${target.id} declares unknown npm package ${packageName}`);
    }
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    if (packageJson.name !== packageName) {
      fail(`${rel(packageDir)}/package.json name must be ${packageName}`);
    }
    if (packageJson.version !== version) {
      fail(`${packageName} package version must match ${product} ${version}`);
    }
    packages.push([packageName, packageDir, target]);
  }
  const expected = packages.map(([packageName]) => packageName).sort(compareText);
  const actual = [...packageDirs.keys()].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${rel(packageRoot)} package descriptors must match published ${product} npm artifact targets for ${surface}`,
    );
  }
  return packages.sort((left, right) => compareText(left[0], right[0]));
}

export function safeNpmPackageFilenamePrefix(packageName) {
  return packageName.replace(/^@/u, '').replace('/', '-');
}

function validateNoConsumerInstallScripts(packageJson, context) {
  const scripts = packageJson.scripts;
  if (scripts === undefined) {
    return;
  }
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
    fail(`${context} scripts must be an object when present`);
  }
  for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (Object.hasOwn(scripts, scriptName)) {
      fail(`${context} must not declare consumer install lifecycle script ${scriptName}`);
    }
  }
}

function npmPackageSourceStageDir(packageName) {
  return path.join(
    ROOT,
    'target/release/npm-package-sources',
    safeNpmPackageFilenamePrefix(packageName),
  );
}

export function stageNpmPackageDescriptor(
  packageName,
  sourceDir,
  version,
  { extraDescriptors = [], target = null } = {},
) {
  const stageDir = npmPackageSourceStageDir(packageName);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const descriptor of ['package.json', 'README.md', ...extraDescriptors]) {
    const source = path.join(sourceDir, descriptor);
    if (!isFile(source)) {
      fail(`${rel(sourceDir)} is missing ${descriptor}`);
    }
    copyFileSync(source, path.join(stageDir, descriptor));
  }
  const packageJsonPath = path.join(stageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.name !== packageName) {
    fail(`${rel(packageJsonPath)} name must be ${packageName}`);
  }
  if (packageJson.version !== version) {
    fail(`${packageName} package version must match ${version}`);
  }
  if (target !== null && packageJson.oliphaunt?.target !== target) {
    fail(`${packageName} package oliphaunt.target must be ${target}`);
  }
  validateNoConsumerInstallScripts(packageJson, `${packageName} npm package`);
  return stageDir;
}

function readReleaseArchiveMember(archive, memberName) {
  const entry = readPortableArchiveEntries(archive).get(memberName);
  if (!entry?.isFile) fail(`${rel(archive)} is missing regular file ${memberName}`);
  return entry.data();
}

export function extractReleaseArchiveFile(archive, memberName, destination, { mode = null } = {}) {
  const data = readReleaseArchiveMember(archive, memberName);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, data);
  if (mode !== null) {
    chmodSync(destination, mode);
  }
}

export function packStagedNpmCarrier(packageDir) {
  return packGeneratedNpmCarrier(packageDir, path.join(ROOT, 'target/release/npm-packages'));
}

export function validatePackedNpmPackage({
  packageName,
  version,
  tarball,
  requiredMembers,
  executableMembers = [],
}) {
  let entries;
  try {
    entries = readPortableArchiveEntries(tarball);
  } catch (error) {
    fail(`${rel(tarball)} is not a valid npm tarball: ${error.message}`);
  }
  if (!entries.has('package/package.json')) {
    fail(`${rel(tarball)} is missing package/package.json`);
  }
  let packageJson;
  try {
    const packageData = entries.get('package/package.json')?.data() ?? null;
    if (packageData === null) {
      fail(`${rel(tarball)} package/package.json could not be read`);
    }
    packageJson = JSON.parse(packageData.toString('utf8'));
  } catch (error) {
    fail(`${rel(tarball)} package/package.json is not valid JSON: ${error.message}`);
  }
  if (packageJson.name !== packageName) {
    fail(
      `${rel(tarball)} package name must be ${packageName}, got ${JSON.stringify(packageJson.name)}`,
    );
  }
  if (packageJson.version !== version) {
    fail(
      `${rel(tarball)} package version must be ${version}, got ${JSON.stringify(packageJson.version)}`,
    );
  }
  try {
    validateNpmTrustedPublishingManifest(packageJson, `${rel(tarball)} package/package.json`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  for (const member of requiredMembers) {
    const entry = entries.get(member);
    if (entry === undefined) {
      fail(`${rel(tarball)} is missing ${member}`);
    }
    if (!entry.isFile || entry.size <= 0) {
      fail(`${rel(tarball)} ${member} must be a non-empty regular file`);
    }
  }
  for (const member of executableMembers) {
    const entry = entries.get(member);
    if (entry === undefined) {
      fail(`${rel(tarball)} is missing executable ${member}`);
    }
    if (!entry.isFile || entry.size <= 0 || (entry.mode & 0o111) === 0) {
      fail(`${rel(tarball)} ${member} must be a non-empty executable file`);
    }
  }
  return packageJson;
}

export function stageWindowsVcRuntimeMembers(
  archive,
  stage,
  target,
  prefix,
  { alreadyExtracted = false, profile } = {},
) {
  if (target !== 'windows-x64-msvc') return [];
  const normalizedPrefix = prefix.replace(/\/+$/u, '');
  const receiptMember = `${normalizedPrefix}/${WINDOWS_VC_RUNTIME_RECEIPT}`;
  const receiptPath = path.join(stage, ...receiptMember.split('/'));
  extractReleaseArchiveFile(archive, receiptMember, receiptPath);
  const receipt = parseWindowsVcRuntimeReceipt(
    readFileSync(receiptPath),
    `${rel(archive)}:${receiptMember}`,
  );
  const names = [...receipt.keys()].sort(compareText);
  if (profile !== undefined) {
    assertSameStringSet(
      `${rel(archive)} ${normalizedPrefix} ${profile} VC runtime profile`,
      names,
      windowsVcRuntimeProfileNames(profile),
    );
  }
  for (const name of names) {
    const member = `${normalizedPrefix}/${name}`;
    const destination = path.join(stage, ...member.split('/'));
    const expectedDigest = receipt.get(name);
    if (!alreadyExtracted || !isFile(destination) || sha256File(destination) !== expectedDigest) {
      extractReleaseArchiveFile(archive, member, destination);
    }
    if (!isFile(destination) || sha256File(destination) !== expectedDigest) {
      fail(`${rel(archive)} exact VC runtime member ${member} does not match ${receiptMember}`);
    }
  }
  return [receiptMember, ...names.map((name) => `${normalizedPrefix}/${name}`)];
}

export const PREFIX = 'artifact-packaging';

export function readJson(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${rel(file)} is not valid JSON: ${error.message}`);
  }
  if (data === null || Array.isArray(data) || typeof data !== 'object') {
    fail(`${rel(file)} must contain a JSON object`);
  }
  return data;
}

export function parseUniquePropertiesText(text) {
  const entries = new Map();
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0) {
      throw new Error(`invalid properties line: ${JSON.stringify(raw)}`);
    }
    const key = line.slice(0, equals);
    if (!key) {
      throw new Error(`properties key must not be empty: ${JSON.stringify(raw)}`);
    }
    if (entries.has(key)) {
      throw new Error(`properties text repeats key ${JSON.stringify(key)}`);
    }
    entries.set(key, line.slice(equals + 1));
  }
  // Object.fromEntries defines every key as data, including names such as
  // __proto__. Exact manifest comparison can therefore reject hostile or
  // undeclared keys instead of losing them through prototype assignment.
  return Object.fromEntries(entries);
}

export function readPropertiesText(text) {
  try {
    return parseUniquePropertiesText(text);
  } catch (error) {
    fail(error.message);
  }
}

export const ARCHIVE_ENTRY_CACHE = new Map();

export const ARCHIVE_ENTRY_CACHE_LIMIT = 2;

export function strictArchiveEntries(file, format) {
  const fileStat = statSync(file, { bigint: true });
  const cacheKey = [
    format,
    path.resolve(file),
    fileStat.dev,
    fileStat.ino,
    fileStat.size,
    fileStat.mtimeNs,
    fileStat.ctimeNs,
  ].join('\0');
  const cached = ARCHIVE_ENTRY_CACHE.get(cacheKey);
  if (cached !== undefined) {
    ARCHIVE_ENTRY_CACHE.delete(cacheKey);
    ARCHIVE_ENTRY_CACHE.set(cacheKey, cached);
    return cached;
  }
  let entries;
  try {
    entries = readPortableArchiveEntries(file, { format });
  } catch (error) {
    fail(`${rel(file)} is not a strict portable ${format} archive: ${error.message}`);
  }
  ARCHIVE_ENTRY_CACHE.set(cacheKey, entries);
  while (ARCHIVE_ENTRY_CACHE.size > ARCHIVE_ENTRY_CACHE_LIMIT) {
    ARCHIVE_ENTRY_CACHE.delete(ARCHIVE_ENTRY_CACHE.keys().next().value);
  }
  return entries;
}

export function archiveTarNames(file) {
  return [...strictArchiveEntries(file, 'tar.gz')]
    .filter(([, entry]) => entry.isFile)
    .map(([name]) => name)
    .sort(compareText);
}

export function readZipEntries(file) {
  return strictArchiveEntries(file, 'zip');
}

export function archiveZipNames(file) {
  return [...readZipEntries(file)]
    .filter(([, entry]) => entry.isFile)
    .map(([name]) => name)
    .sort(compareText);
}

const SDK_ROOT = path.join(ROOT, 'target/sdk-artifacts');

const SDK_RUNTIME_PAYLOAD_PATTERNS = [
  /(^|\/)assets\/oliphaunt\/runtime\//u,
  /(^|\/)assets\/oliphaunt\/cluster-seed\//u,
  /(^|\/)assets\/oliphaunt\/static-registry\/archives\//u,
  /(^|\/)oliphaunt\/runtime\/files\//u,
  /(^|\/)runtime\/files\/share\/postgresql\//u,
  /(^|\/)share\/postgresql\/extension\/[^/]+\.(control|sql)$/u,
  /(^|\/)release-assets\//u,
  /(^|\/)extension-artifacts\.json$/u,
  /(^|\/)liboliphaunt\.(so|dylib|dll|a|lib)$/u,
  /(^|\/)liboliphaunt_extensions\.(so|dylib|dll|a|lib)$/u,
  /(^|\/)liboliphaunt_extension_[^/]+\.(so|dylib|dll|a|lib)$/u,
  /\.xcframework(\/|$)/u,
];

const KOTLIN_ALLOWED_NATIVE_PAYLOADS = new Set(['liboliphaunt_mobile_bindings.so']);

export function tarReadBytes(file, member) {
  const entry = strictArchiveEntries(file, 'tar.gz').get(member);
  if (!entry?.isFile) fail(`${rel(file)} is missing regular-file member ${member}`);
  return Buffer.from(entry.data());
}

export function tarReadText(file, member) {
  return tarReadBytes(file, member).toString('utf8');
}

export function cargoCrateManifest(file) {
  const manifests = archiveTarNames(file).filter(
    (name) => name.split('/').length === 2 && name.endsWith('/Cargo.toml'),
  );
  if (manifests.length !== 1) {
    fail(`${rel(file)} must contain exactly one top-level Cargo.toml`);
  }
  let data;
  try {
    data = Bun.TOML.parse(tarReadText(file, manifests[0]));
  } catch (error) {
    fail(`${rel(file)} contains an invalid Cargo.toml: ${error.message}`);
  }
  if (data === null || Array.isArray(data) || typeof data !== 'object') {
    fail(`${rel(file)} Cargo.toml must contain a TOML table`);
  }
  return data;
}

const CARGO_VIRTUAL_PACKAGE_FILES = new Set([
  '.cargo_vcs_info.json',
  'Cargo.lock',
  'Cargo.toml.orig',
]);

export function cargoPackageMemberContractViolation(actual, listed) {
  if (new Set(listed).size !== listed.length) {
    return { kind: 'listing-duplicate' };
  }
  const expected = listed.filter((entry) => !CARGO_VIRTUAL_PACKAGE_FILES.has(entry));
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    return { kind: 'mismatch', actual: actualSorted, expected: expectedSorted };
  }
  return null;
}

export function requireCrateMatchesCargoListing(crate, listing, packageName, packageVersion) {
  if (!isFile(listing)) {
    fail(`missing Cargo package listing: ${rel(listing)}`);
  }
  const listed = readFileSync(listing, 'utf8')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const prefix = `${packageName}-${packageVersion}/`;
  const actual = archiveTarNames(crate).map((entry) => {
    if (!entry.startsWith(prefix) || entry.length === prefix.length) {
      fail(`${rel(crate)} contains member outside ${prefix.slice(0, -1)}: ${entry}`);
    }
    return entry.slice(prefix.length);
  });
  const violation = cargoPackageMemberContractViolation(actual, listed);
  if (violation?.kind === 'listing-duplicate') {
    fail(`${rel(listing)} repeats a Cargo package entry`);
  }
  if (violation?.kind === 'mismatch') {
    fail(
      `${rel(crate)} Cargo-selected package members mismatch: ` +
        `expected=${JSON.stringify(violation.expected)}, actual=${JSON.stringify(violation.actual)}`,
    );
  }
}

export function directoryNames(root) {
  const result = [];
  const visit = (dir) => {
    if (!isDirectory(dir)) {
      return;
    }
    for (const name of readdirSync(dir).sort(compareText)) {
      const file = path.join(dir, name);
      if (isDirectory(file)) {
        visit(file);
      } else if (isFile(file)) {
        result.push(relFrom(root, file));
      }
    }
  };
  visit(root);
  return result.sort(compareText);
}

function relFrom(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function findSdkRuntimePayloadViolation(product, names, allowedNames = new Set()) {
  for (const name of names) {
    if (allowedNames.has(name)) {
      continue;
    }
    const basename = path.basename(name);
    if (product === 'oliphaunt-kotlin' && KOTLIN_ALLOWED_NATIVE_PAYLOADS.has(basename)) {
      continue;
    }
    for (const pattern of SDK_RUNTIME_PAYLOAD_PATTERNS) {
      if (pattern.test(name)) {
        return name;
      }
    }
  }
  return null;
}

export function rejectSdkRuntimePayload(product, artifact, names, allowedNames = new Set()) {
  const violation = findSdkRuntimePayloadViolation(product, names, allowedNames);
  if (violation !== null) {
    fail(
      `${product} SDK artifact ${rel(artifact)} must not include runtime/extension payload ${violation}`,
    );
  }
}

export async function inspectSdkProduct(product, inspect) {
  const root = path.join(SDK_ROOT, product);
  if (!existsSync(root)) fail(`missing staged SDK artifacts for ${product} under ${rel(root)}`);
  const checked = await inspect(root);
  if (!checked)
    fail(`${product} did not contain any inspectable staged package artifacts under ${rel(root)}`);
  console.log(`validated SDK artifact cleanliness: ${product}`);
  return checked;
}

export function walkFiles(root) {
  if (!isDirectory(root)) {
    return [];
  }
  const result = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort(compareText)) {
      const file = path.join(dir, name);
      if (isDirectory(file)) {
        visit(file);
      } else if (isFile(file)) {
        result.push(file);
      }
    }
  };
  visit(root);
  return result;
}
