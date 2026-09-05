import path from 'node:path';

import { prepareWasixTypescriptPackage as prepareProductPackage } from '../../src/bindings/wasix-ts/tools/package.mjs';

import { readPortableArchiveEntries } from '../../src/shared/artifact-packaging/portable-archive.mjs';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releasePackageLicense,
  stageReleaseNotices,
} from './release-notices.mjs';

const TOOL = 'wasix-typescript-package.mjs';
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
    manifest.name !== PACKAGE_NAME
    || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version)
    || manifest.private === true
    || manifest.license !== releasePackageLicense().spdx
    || manifest.type !== 'module'
    || manifest.publishConfig?.access !== 'public'
    || manifest.publishConfig?.provenance !== true
  ) {
    fail(`${label} is not the stable-version public ESM ${PACKAGE_NAME} package`);
  }
  if (manifest.scripts !== undefined || manifest.devDependencies !== undefined) {
    fail(`${label} must not publish development scripts or dependencies`);
  }
  const dependencies = manifest.dependencies ?? {};
  const optionalDependencies = manifest.optionalDependencies ?? {};
  const expectedDependencies = [FZSTD_PACKAGE, RUNTIME_PACKAGE].sort(compareText);
  const nativeVersion = manifest.oliphaunt?.wasixNapiVersion;
  if (
    JSON.stringify(sortedKeys(dependencies)) !== JSON.stringify(expectedDependencies)
    || typeof dependencies[RUNTIME_PACKAGE] !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(dependencies[RUNTIME_PACKAGE])
    || dependencies[FZSTD_PACKAGE] !== FZSTD_VERSION
    || typeof nativeVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(nativeVersion)
    || JSON.stringify(sortedKeys(optionalDependencies))
      !== JSON.stringify([...NATIVE_PACKAGES].sort(compareText))
    || NATIVE_PACKAGES.some((name) => optionalDependencies[name] !== nativeVersion)
    || sortedKeys(manifest.peerDependencies).length !== 0
    || manifest.peerDependenciesMeta !== undefined
    || manifest.bundledDependencies !== undefined
    || manifest.bundleDependencies !== undefined
  ) {
    fail(
      `${label} must depend only on the exact portable runtime, decompressor, and native platform carriers`,
    );
  }
  const root = manifest.exports?.['.'];
  const expectedExports = [
    '.',
    './direct',
    './worker',
    './package.json',
    './internal/tools',
    './server',
    './storage/bun',
    './storage/deno',
    './storage/indexed-db',
    './storage/node',
    './storage/opfs',
  ].sort(compareText);
  if (JSON.stringify(sortedKeys(manifest.exports)) !== JSON.stringify(expectedExports)) {
    fail(`${label} exports do not match the deliberate public package surface`);
  }
  if (
    JSON.stringify(Object.keys(root ?? {}))
      !== JSON.stringify(['types', 'deno', 'bun', 'node', 'browser', 'default'])
    || root?.types !== './lib/index.d.ts'
    || root?.deno !== './lib/index.deno.js'
    || root?.bun !== './lib/index.bun.js'
    || root?.browser !== './lib/index.js'
    || root?.node !== './lib/index.node.js'
    || root?.default !== './lib/index.js'
  ) {
    fail(`${label} must expose exact browser, Node, Bun, and Deno conditional entrypoints`);
  }
  const worker = manifest.exports?.['./worker'];
  if (
    JSON.stringify(Object.keys(worker ?? {}))
      !== JSON.stringify(['types', 'deno', 'bun', 'node', 'browser', 'default'])
    || worker?.types !== './lib/worker-entry.d.ts'
    || worker?.deno !== './lib/worker-entry.deno.js'
    || worker?.bun !== './lib/worker-entry.bun.js'
    || worker?.node !== './lib/worker-entry.node.js'
    || worker?.browser !== './lib/worker-entry.js'
    || worker?.default !== './lib/worker-entry.js'
  ) {
    fail(`${label} must expose the exact browser, Node, Bun, and Deno worker entrypoint`);
  }
  const direct = manifest.exports?.['./direct'];
  if (
    JSON.stringify(Object.keys(direct ?? {}))
      !== JSON.stringify(['types', 'deno', 'bun', 'node'])
    || direct?.types !== './lib/direct.node.d.ts'
    || direct?.deno !== './lib/direct.node.js'
    || direct?.bun !== './lib/direct.node.js'
    || direct?.node !== './lib/direct.node.js'
  ) {
    fail(`${label} must expose one exact host-only conditional direct entrypoint`);
  }
  const internalTools = manifest.exports?.['./internal/tools'];
  if (
    internalTools?.types !== './lib/internal.d.ts'
    || internalTools?.deno !== './lib/internal.node.js'
    || internalTools?.bun !== './lib/internal.node.js'
    || internalTools?.node !== './lib/internal.node.js'
    || internalTools?.browser !== './lib/internal.js'
    || internalTools?.default !== './lib/internal.js'
  ) {
    fail(`${label} must expose the exact version-locked optional-tools bridge`);
  }
  const server = manifest.exports?.['./server'];
  if (
    JSON.stringify(Object.keys(server ?? {}))
      !== JSON.stringify(['types', 'deno', 'bun', 'node'])
    || server?.types !== './lib/server.node.d.ts'
    || server?.deno !== './lib/server.node.js'
    || server?.bun !== './lib/server.node.js'
    || server?.node !== './lib/server.node.js'
  ) {
    fail(`${label} must expose one exact host-only conditional local-server entrypoint`);
  }
  const nodeStorage = manifest.exports?.['./storage/node'];
  if (
    JSON.stringify(sortedKeys(nodeStorage)) !== JSON.stringify(['node', 'types'])
    || nodeStorage?.types !== './lib/storage/node.d.ts'
    || nodeStorage?.node !== './lib/storage/node.js'
    || nodeStorage?.browser !== undefined
    || nodeStorage?.default !== undefined
  ) {
    fail(`${label} must expose directory storage only under the Node condition`);
  }
  const bunStorage = manifest.exports?.['./storage/bun'];
  if (
    bunStorage?.types !== './lib/storage/bun.d.ts'
    || bunStorage?.bun !== './lib/storage/bun.js'
    || sortedKeys(bunStorage).some((condition) => !['bun', 'types'].includes(condition))
  ) {
    fail(`${label} must expose Bun directory storage only under the Bun condition`);
  }
  const denoStorage = manifest.exports?.['./storage/deno'];
  if (
    denoStorage?.types !== './lib/storage/deno.d.ts'
    || denoStorage?.deno !== './lib/storage/deno.js'
    || sortedKeys(denoStorage).some((condition) => !['deno', 'types'].includes(condition))
  ) {
    fail(`${label} must expose Deno directory storage only under the Deno condition`);
  }
  const indexedDbStorage = manifest.exports?.['./storage/indexed-db'];
  if (
    JSON.stringify(sortedKeys(indexedDbStorage)) !== JSON.stringify(['default', 'types'])
    || indexedDbStorage?.types !== './lib/storage/indexed-db.d.ts'
    || indexedDbStorage?.default !== './lib/storage/indexed-db.js'
  ) {
    fail(`${label} must expose the exact IndexedDB storage entrypoint`);
  }
  const opfsStorage = manifest.exports?.['./storage/opfs'];
  if (
    JSON.stringify(sortedKeys(opfsStorage)) !== JSON.stringify(['default', 'types'])
    || opfsStorage?.types !== './lib/storage/opfs.d.ts'
    || opfsStorage?.default !== './lib/storage/opfs.js'
  ) {
    fail(`${label} must expose the exact OPFS storage entrypoint`);
  }
  const packageJson = manifest.exports?.['./package.json'];
  if (
    JSON.stringify(sortedKeys(packageJson)) !== JSON.stringify(['default'])
    || packageJson?.default !== './package.json'
  ) {
    fail(`${label} must expose only its package.json at the package metadata entrypoint`);
  }
  if (
    manifest.engines?.node !== '>=22.13 <25'
    || manifest.engines?.bun !== '>=1.3.14'
    || manifest.engines?.deno !== '>=2.8.1'
  ) {
    fail(`${label} must declare the qualified Node, Bun, and Deno runtime floors`);
  }
  if (
    manifest.oliphaunt?.runtimeProduct !== 'liboliphaunt-wasix'
    || manifest.oliphaunt?.runtimeVersion !== dependencies[RUNTIME_PACKAGE]
    || manifest.oliphaunt?.wasixNapiProduct !== NATIVE_PRODUCT
    || manifest.oliphaunt?.wasixAddonAbiVersion !== 1
    || manifest.oliphaunt?.nodeApiVersion !== 8
    || manifest.oliphaunt?.browserHost !== 'wasmer-js-patched'
    || manifest.oliphaunt?.serverHost !== 'wasix-rust-napi'
  ) {
    fail(`${label} runtime compatibility metadata differs from its exact dependencies`);
  }
  return manifest;
}

export function prepareWasixTypescriptPackage(packageDir) {
  const root = path.resolve(packageDir);
  const manifest = prepareProductPackage(root);
  stageReleaseNotices(root, NOTICE_OPTIONS);
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
  if (JSON.stringify([...(manifest.files ?? [])].sort(compareText)) !== JSON.stringify(packageFiles)) {
    fail(`${path.basename(file)} package.json files differ from the owned package roots`);
  }
  const allowedFiles = new Set(['package.json', ...manifest.files.filter((name) => name !== 'lib')]);
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
