import path from 'node:path';

import { prepareWasixTypescriptPackage as prepareProductPackage } from './package.mts';
const QUERY_PACKAGE = '@oliphaunt/ts-query';

import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releasePackageLicense,
} from '../../../../../tools/packaging/release-notices.mts';

const TOOL = 'wasix-typescript-package.mts';
const PACKAGE_NAME = '@oliphaunt/wasix-ts';
const RUNTIME_PACKAGE = '@oliphaunt/liboliphaunt-wasix';
const FZSTD_PACKAGE = 'fzstd';
const FZSTD_VERSION = '0.1.1';
const NATIVE_PRODUCT = 'oliphaunt-wasix-napi';
const NATIVE_PACKAGES = Object.freeze([
  '@oliphaunt/wasix-napi-darwin-arm64',
  '@oliphaunt/wasix-napi-linux-arm64-gnu',
  '@oliphaunt/wasix-napi-linux-x64-gnu',
  '@oliphaunt/wasix-napi-win32-x64-msvc',
]);
const NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort(compareText);
}

export function assertWasixTypescriptManifest(manifest, label = `${PACKAGE_NAME} package.json`) {
  if (
    manifest.name !== PACKAGE_NAME ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== releasePackageLicense().spdx ||
    manifest.type !== 'module' ||
    manifest.publishConfig?.access !== 'public' ||
    manifest.publishConfig?.provenance !== true
  ) {
    fail(`${label} is not the stable-version public ESM ${PACKAGE_NAME} package`);
  }
  if (manifest.scripts !== undefined || manifest.devDependencies !== undefined) {
    fail(`${label} must not publish development scripts or dependencies`);
  }
  const dependencies = manifest.dependencies ?? {};
  const optionalDependencies = manifest.optionalDependencies ?? {};
  const expectedDependencies = [FZSTD_PACKAGE, QUERY_PACKAGE, RUNTIME_PACKAGE].sort(compareText);
  const nativeVersion = manifest.oliphaunt?.wasixNapiVersion;
  if (
    JSON.stringify(sortedKeys(dependencies)) !== JSON.stringify(expectedDependencies) ||
    typeof dependencies[RUNTIME_PACKAGE] !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(dependencies[RUNTIME_PACKAGE]) ||
    dependencies[FZSTD_PACKAGE] !== FZSTD_VERSION ||
    !/^\d+\.\d+\.\d+$/u.test(dependencies[QUERY_PACKAGE]) ||
    typeof nativeVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(nativeVersion) ||
    JSON.stringify(sortedKeys(optionalDependencies)) !==
      JSON.stringify([...NATIVE_PACKAGES].sort(compareText)) ||
    NATIVE_PACKAGES.some((name) => optionalDependencies[name] !== nativeVersion) ||
    sortedKeys(manifest.peerDependencies).length !== 0 ||
    manifest.peerDependenciesMeta !== undefined ||
    manifest.bundledDependencies !== undefined ||
    manifest.bundleDependencies !== undefined
  ) {
    fail(
      `${label} must depend only on its query package, portable runtime, decompressor, and native platform carriers`,
    );
  }
  if (
    manifest.engines?.node !== '>=22.13 <25' ||
    manifest.engines?.bun !== '>=1.3.14' ||
    manifest.engines?.deno !== '>=2.8.1'
  ) {
    fail(`${label} must declare the qualified Node, Bun, and Deno runtime floors`);
  }
  if (
    manifest.oliphaunt?.runtimeProduct !== 'liboliphaunt-wasix' ||
    manifest.oliphaunt?.runtimeVersion !== dependencies[RUNTIME_PACKAGE] ||
    manifest.oliphaunt?.wasixNapiProduct !== NATIVE_PRODUCT ||
    manifest.oliphaunt?.wasixAddonAbiVersion !== 2 ||
    manifest.oliphaunt?.nodeApiVersion !== 8 ||
    manifest.oliphaunt?.browserHost !== 'wasmer-js-patched' ||
    manifest.oliphaunt?.serverHost !== 'wasix-rust-napi'
  ) {
    fail(`${label} runtime compatibility metadata differs from its exact dependencies`);
  }
  return manifest;
}

export function prepareWasixTypescriptPackage(packageDir) {
  const root = path.resolve(packageDir);
  const manifest = prepareProductPackage(root);
  assertReleaseNoticesInDirectory(root, NOTICE_OPTIONS);
  assertWasixTypescriptManifest(manifest, `${PACKAGE_NAME} staged package.json`);
  return manifest;
}

export function assertWasixTypescriptNpmArchive(archive) {
  const file = path.resolve(archive);
  assertReleaseNoticesInArchive(file, {
    ...NOTICE_OPTIONS,
    prefix: 'package',
    label: path.basename(file),
  });
  const entries = readPortableArchiveEntries(file);
  const requireFile = (name) => {
    const entry = entries.get(`package/${name}`);
    if (!entry?.isFile || entry.isSymbolicLink || entry.size <= 0) {
      fail(`${path.basename(file)} is missing non-empty regular package/${name}`);
    }
    return Buffer.from(entry.data());
  };
  const manifest = assertWasixTypescriptManifest(
    JSON.parse(requireFile('package.json').toString('utf8')),
    `${path.basename(file)} package.json`,
  );
  const packageFiles = [
    'ARCHITECTURE.md',
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'lib',
  ];
  if (
    JSON.stringify([...(manifest.files ?? [])].sort(compareText)) !== JSON.stringify(packageFiles)
  ) {
    fail(`${path.basename(file)} package.json files differ from the owned package roots`);
  }
  const allowedFiles = new Set([
    'package.json',
    ...manifest.files.filter((name) => name !== 'lib'),
  ]);
  for (const [name, entry] of entries) {
    if (entry.isSymbolicLink) fail(`${path.basename(file)} contains symbolic link ${name}`);
    const relative = name.replace(/^package\//u, '');
    if (entry.isFile && !allowedFiles.has(relative) && !relative.startsWith('lib/')) {
      fail(`${path.basename(file)} contains file outside package.json files: ${name}`);
    }
  }
  for (const name of manifest.files) {
    if (name === 'lib' || (name === 'CHANGELOG.md' && manifest.version === '0.0.0')) continue;
    requireFile(name);
  }
  const exportedFiles = new Set();
  const visit = (value) => {
    if (typeof value === 'string' && value.startsWith('./')) exportedFiles.add(value.slice(2));
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(manifest.exports);
  for (const name of exportedFiles) {
    requireFile(name);
  }
  JSON.parse(requireFile('lib/host/provenance.json').toString('utf8'));
  return manifest;
}
