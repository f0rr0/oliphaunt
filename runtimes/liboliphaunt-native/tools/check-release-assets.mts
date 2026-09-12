#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseProperties } from '../../../database-resources/contracts/native-manifest.mts';
import { inspectPlatformBinaryTree } from '../../../tools/packaging/platform-binary-contract.mts';
import { readPortableArchiveEntries } from '../../../tools/packaging/portable-archive.mts';
import { assertReleaseNoticesInArchive } from '../../../tools/packaging/release-notices.mts';
import {
  allArtifactTargets,
  compareText,
  currentProductVersion,
  ROOT,
} from '../../../tools/release/release-artifact-targets.mts';
import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
} from './native-mobile-abi-contract.mts';
import { SNOWBALL_STOPWORD_LANGUAGES, validatePayload } from './native-runtime-payload.mts';

const PREFIX = 'check-liboliphaunt-release-assets.mts';
const PRODUCT = 'liboliphaunt-native';

function fail(message) {
  console.error(`${PREFIX}: ${message}`);
  process.exit(1);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return file;
  }
  return relative.split(path.sep).join('/');
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function requireFile(file, description) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    fail(`missing ${description}: ${file}`);
  }
  if (!stat.isFile()) {
    fail(`${description} is not a file: ${file}`);
  }
  if (stat.size <= 0) {
    fail(`${description} is empty: ${file}`);
  }
}

function parseChecksumFile(file) {
  const checksums = new Map();
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (!rawLine.trim()) {
      continue;
    }
    const parts = rawLine.trim().split(/\s+/u);
    if (parts.length !== 2) {
      fail(`malformed checksum line in ${file}: ${JSON.stringify(rawLine)}`);
    }
    const [digest, filename] = parts;
    if (!filename.startsWith('./')) {
      fail(`checksum path must be relative './name': ${filename}`);
    }
    checksums.set(filename.slice(2), digest);
  }
  return checksums;
}

function validateChecksums(assetDir, checksumFile) {
  const checksums = parseChecksumFile(checksumFile);
  const expectedAssets = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((file) => statSync(file).isFile() && path.extname(file) !== '.sha256')
    .sort(compareText);
  if (expectedAssets.length === 0) {
    fail(`no release assets found in ${assetDir}`);
  }
  const assetNames = new Set(expectedAssets.map((file) => path.basename(file)));
  for (const asset of expectedAssets) {
    const recorded = checksums.get(path.basename(asset));
    if (!recorded) {
      fail(`checksum file does not cover release asset: ${path.basename(asset)}`);
    }
    const actual = sha256(asset);
    if (recorded !== actual) {
      fail(`checksum mismatch for ${path.basename(asset)}: expected ${recorded}, got ${actual}`);
    }
  }
  const extra = [...checksums.keys()].filter((name) => !assetNames.has(name)).sort(compareText);
  if (extra.length > 0) {
    fail(`checksum file contains entries for missing assets: ${extra.join(', ')}`);
  }
}

function generatedExtensionMetadata() {
  const metadataPath = path.join(ROOT, 'extensions/generated/sdk/extensions.json');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    fail(`read generated Rust SDK extension metadata ${metadataPath}: ${error.message}`);
  }
  if (!Array.isArray(metadata.extensions)) {
    fail(`${metadataPath} must define an extensions array`);
  }
  const expected = new Map();
  for (const [index, row] of metadata.extensions.entries()) {
    if (row === null || Array.isArray(row) || typeof row !== 'object') {
      fail(`${metadataPath} extensions[${index}] must be an object`);
    }
    const sqlName = row['sql-name'];
    if (typeof sqlName !== 'string' || !sqlName) {
      fail(`${metadataPath} extensions[${index}] must define sql-name`);
    }
    const dataFiles = row['runtime-share-data-files'];
    if (!Array.isArray(dataFiles) || !dataFiles.every((value) => typeof value === 'string')) {
      fail(`${metadataPath} extension ${sqlName} must define runtime-share-data-files`);
    }
    const nativeModuleStem = row['native-module-stem'];
    if (
      nativeModuleStem !== null &&
      nativeModuleStem !== undefined &&
      typeof nativeModuleStem !== 'string'
    ) {
      fail(`${metadataPath} extension ${sqlName} native-module-stem must be a string or null`);
    }
    expected.set(sqlName, {
      createsExtension: row['creates-extension'] === true,
      dataFiles,
      dataFilesTsv: dataFiles.length > 0 ? dataFiles.join(',') : '-',
      nativeModuleStem,
    });
  }
  return expected;
}

function readArchiveEntries(file) {
  try {
    return readPortableArchiveEntries(file);
  } catch (error) {
    fail(`${file} is not a strict portable release archive: ${error.message}`);
  }
}

function archiveText(entries, file, memberName) {
  const entry = entries.get(memberName);
  if (!entry) {
    fail(`${file} is missing ${memberName}`);
  }
  if (!entry.isFile) {
    fail(`${file} member ${memberName} is not a regular file`);
  }
  try {
    const data = typeof entry.data === 'function' ? entry.data() : entry.data;
    return Buffer.from(data).toString('utf8');
  } catch (error) {
    fail(`${file} member ${memberName} is not readable UTF-8: ${error.message}`);
  }
}

function validateMobileAbiProofEntries(entries, file, domain, prefix = 'oliphaunt/') {
  const targets = NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[domain];
  if (targets === undefined) fail(`${file} uses unsupported mobile ABI domain ${domain}`);
  const proofPrefix = `${prefix}provenance/native-mobile-abi/`;
  try {
    compareNativeMobileAbiReceipts(
      domain,
      targets.map((target) => {
        const member = `${proofPrefix}${target}.properties`;
        return { label: `${file} ${member}`, text: archiveText(entries, file, member) };
      }),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function extractArchive(file, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const [name, entry] of readArchiveEntries(file)) {
    if (entry.isDirectory) {
      continue;
    }
    if (!entry.isFile) {
      fail(`${file} member ${name} must be a regular file`);
    }
    const output = path.join(destination, ...name.split('/'));
    mkdirSync(path.dirname(output), { recursive: true });
    const data = typeof entry.data === 'function' ? entry.data() : entry.data;
    writeFileSync(output, data);
    if (entry.mode) {
      chmodSync(output, entry.mode & 0o777);
    }
  }
}

async function validateNativeTargetArtifact(file, target, { requireRuntime, toolSet }) {
  if (requireRuntime && toolSet === 'runtime') {
    const entries = readPortableArchiveEntries(file);
    if (target === 'windows-x64-msvc') {
      for (const directory of ['bin', 'runtime/bin']) {
        for (const name of ['icudt76.dll', 'icuin76.dll', 'icuuc76.dll']) {
          const member = `${directory}/${name}`;
          const entry = entries.get(member);
          if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
            fail(`${file} ICU-enabled Windows runtime is missing ${member}`);
          }
        }
      }
    }
  }
  const temp = mkdtempSync(path.join(tmpdir(), `oliphaunt-native-${target}-`));
  try {
    const extracted = path.join(temp, 'payload');
    extractArchive(file, extracted);
    await inspectPlatformBinaryTree(extracted, {
      target,
      requireWindowsRuntimeImportLibrary: target === 'windows-x64-msvc' && toolSet === 'runtime',
      windowsVcRuntimeProfile:
        target === 'windows-x64-msvc' && toolSet === 'runtime' ? 'provider' : undefined,
    });
    validatePayload(extracted, target, { requireRuntime, toolSet });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function assetName(target, version) {
  return target.asset.replaceAll('{version}', version);
}

async function validateNativeTargetArtifacts(assetDir, version) {
  const runtimeTargets = new Set(
    allArtifactTargets({
      product: PRODUCT,
      kind: 'native-runtime',
      surface: 'rust-native-direct',
    }).map((target) => target.target),
  );
  for (const target of allArtifactTargets({
    product: PRODUCT,
    kind: 'native-runtime',
    surface: 'github-release',
  })) {
    await validateNativeTargetArtifact(
      path.join(assetDir, assetName(target, version)),
      target.target,
      {
        requireRuntime: runtimeTargets.has(target.target),
        toolSet: 'runtime',
      },
    );
  }
  for (const target of allArtifactTargets({
    product: PRODUCT,
    kind: 'native-tools',
    surface: 'github-release',
  })) {
    await validateNativeTargetArtifact(
      path.join(assetDir, assetName(target, version)),
      target.target,
      {
        requireRuntime: true,
        toolSet: 'tools',
      },
    );
  }
}

function validateRuntimeResourceArtifactContents(file, { target, extensionMetadata }) {
  const entries = readArchiveEntries(file);
  const names = new Set(entries.keys());
  const runtimePrefix = 'oliphaunt/runtime/files/';
  for (const requiredMember of [
    'oliphaunt/runtime/manifest.properties',
    'oliphaunt/static-registry/manifest.properties',
  ]) {
    if (!names.has(requiredMember)) {
      fail(`${file} must contain ${requiredMember}`);
    }
  }
  if (
    !names.has(`${runtimePrefix}share/postgresql/README.release-fixture`) &&
    ![...names].some((name) => name.startsWith(runtimePrefix))
  ) {
    fail(`${file} must contain an oliphaunt/runtime/files tree`);
  }
  if ([...names].some((name) => name.startsWith(`${runtimePrefix}share/icu/`))) {
    fail(`${file} standard runtime must not contain ICU data under ${runtimePrefix}share/icu`);
  }
  for (const required of [
    `${runtimePrefix}share/postgresql/extension/plpgsql--1.0.sql`,
    `${runtimePrefix}share/postgresql/extension/plpgsql.control`,
    `${runtimePrefix}share/postgresql/snowball_create.sql`,
    ...SNOWBALL_STOPWORD_LANGUAGES.map(
      (language) => `${runtimePrefix}share/postgresql/tsearch_data/${language}.stop`,
    ),
  ]) {
    const entry = entries.get(required);
    if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
      fail(`${file} standard runtime is missing required core PostgreSQL resource ${required}`);
    }
  }
  for (const [sqlName, metadata] of extensionMetadata) {
    const control = `${runtimePrefix}share/postgresql/extension/${sqlName}.control`;
    if (names.has(control)) {
      fail(`${file} standard runtime must not contain optional extension control file ${control}`);
    }
    for (const dataFile of metadata.dataFiles) {
      const dataPath = `${runtimePrefix}share/postgresql/${dataFile}`;
      if (names.has(dataPath)) {
        fail(`${file} standard runtime must not contain optional extension data file ${dataPath}`);
      }
    }
    if (typeof metadata.nativeModuleStem === 'string' && metadata.nativeModuleStem) {
      for (const suffix of ['.dylib', '.so', '.dll']) {
        const module = `${runtimePrefix}lib/postgresql/${metadata.nativeModuleStem}${suffix}`;
        if (names.has(module)) {
          fail(`${file} standard runtime must not contain optional extension module ${module}`);
        }
      }
    }
  }

  validateMobileAbiProofEntries(entries, file, target);
  const runtime = parseProperties(
    Buffer.from(archiveText(entries, file, 'oliphaunt/runtime/manifest.properties')),
    `${file} runtime manifest`,
  );
  if (
    runtime.get('schema') !== 'oliphaunt-runtime-resources-v1' ||
    runtime.get('layout') !== 'postgres-runtime-files-v1' ||
    runtime.get('artifactRole') !== 'runtime' ||
    runtime.get('mode') !== 'native-direct' ||
    runtime.get('clusterSeedTarget') !== target ||
    runtime.get('mobileStaticRegistryState') !== 'not-required' ||
    [
      'selectedExtensions',
      'extensions',
      'runtimeFeatures',
      'sharedPreloadLibraries',
      'mobileStaticRegistryRegistered',
      'mobileStaticRegistryPending',
      'nativeModuleStems',
      'mobileStaticRegistrySource',
    ].some((key) => runtime.get(key))
  ) {
    fail(`${file} base runtime metadata is incompatible with ${target}`);
  }
  const registry = parseProperties(
    Buffer.from(archiveText(entries, file, 'oliphaunt/static-registry/manifest.properties')),
    `${file} static registry`,
  );
  if (
    registry.get('state') !== 'not-required' ||
    registry.get('registeredExtensions') ||
    registry.get('pendingExtensions')
  ) {
    fail(`${file} base runtime must not contain a static extension registry`);
  }
}

const RELEASE_NOTICE_OPTIONS_BY_KIND = new Map([
  ['native-runtime', Object.freeze({ profile: 'native-runtime' })],
  ['native-tools', Object.freeze({ profile: 'native-tools' })],
  [
    'apple-swiftpm-binary',
    Object.freeze({
      profile: 'native-runtime',
      prefix: 'liboliphaunt.xcframework',
    }),
  ],
  ['runtime-resources', Object.freeze({ profile: 'native-runtime-resources' })],
]);

export function assertLiboliphauntArtifactReleaseNotices(file, kind) {
  const options = RELEASE_NOTICE_OPTIONS_BY_KIND.get(kind);
  if (options === undefined) {
    return false;
  }
  assertReleaseNoticesInArchive(file, options);
  return true;
}

function validateReleaseNoticeClosure(assetDir, version) {
  for (const target of allArtifactTargets({
    product: PRODUCT,
    surface: 'github-release',
  })) {
    assertLiboliphauntArtifactReleaseNotices(
      path.join(assetDir, assetName(target, version)),
      target.kind,
    );
  }
}

function expectedGithubAssets(version) {
  return allArtifactTargets({
    product: PRODUCT,
    surface: 'github-release',
  })
    .map((target) => assetName(target, version))
    .sort(compareText);
}

async function validate(assetDir) {
  const version = await currentProductVersion(PRODUCT, PREFIX);
  const metadata = generatedExtensionMetadata();
  const required = expectedGithubAssets(version);
  const expected = new Set(required);
  const actual = new Set(
    readdirSync(assetDir).filter((name) => statSync(path.join(assetDir, name)).isFile()),
  );
  const missing = [...expected].filter((name) => !actual.has(name)).sort(compareText);
  if (missing.length > 0) {
    fail(
      `liboliphaunt-native release asset directory is missing expected assets: ${missing.join(', ')}`,
    );
  }
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort(compareText);
  if (unexpected.length > 0) {
    fail(
      `liboliphaunt-native release asset directory contains unexpected assets: ${unexpected.join(', ')}`,
    );
  }
  for (const filename of required) {
    requireFile(path.join(assetDir, filename), `liboliphaunt release artifact ${filename}`);
  }
  validateReleaseNoticeClosure(assetDir, version);
  const leakedExtensionAssets = [...actual]
    .filter((name) => name.includes('extension') && !name.endsWith('-release-assets.sha256'))
    .sort(compareText);
  if (leakedExtensionAssets.length > 0) {
    fail(
      'liboliphaunt-native release assets must not include exact-extension artifacts; ' +
        `publish them through oliphaunt-extension-* products instead: ${leakedExtensionAssets.join(', ')}`,
    );
  }
  for (const target of ['ios-datum64', 'android-datum64']) {
    validateRuntimeResourceArtifactContents(
      path.join(assetDir, `liboliphaunt-${version}-runtime-resources-${target}.tar.gz`),
      { target, extensionMetadata: metadata },
    );
  }
  for (const filename of [
    `liboliphaunt-${version}-ios-xcframework.tar.gz`,
    `liboliphaunt-${version}-apple-spm-xcframework.zip`,
  ]) {
    const file = path.join(assetDir, filename);
    const entries = readArchiveEntries(file);
    for (const slice of ['ios-arm64', 'ios-arm64-simulator']) {
      validateMobileAbiProofEntries(
        entries,
        file,
        'ios-datum64',
        `liboliphaunt.xcframework/${slice}/liboliphaunt.framework/Resources/oliphaunt/`,
      );
    }
  }
  await validateNativeTargetArtifacts(assetDir, version);
  validateChecksums(assetDir, path.join(assetDir, `liboliphaunt-${version}-release-assets.sha256`));
}

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, 'target/liboliphaunt/release-assets'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--asset-dir') {
      const value = argv[index + 1];
      if (!value) {
        fail('--asset-dir requires a value');
      }
      args.assetDir = path.resolve(ROOT, value);
      index += 1;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  return args;
}

export async function checkLiboliphauntReleaseAssets(argv = Bun.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!existsSync(args.assetDir) || !statSync(args.assetDir).isDirectory()) {
    fail(`release asset directory does not exist: ${args.assetDir}`);
  }
  await validate(args.assetDir);
  console.log(`liboliphaunt release assets validated: ${rel(args.assetDir)}`);
}

if (import.meta.main) await checkLiboliphauntReleaseAssets();
