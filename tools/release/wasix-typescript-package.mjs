import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readPortableArchiveEntries } from './portable-archive.mjs';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releasePackageLicense,
  stageReleaseNotices,
} from './release-notices.mjs';

const TOOL = 'wasix-typescript-package.mjs';
const PACKAGE_NAME = '@oliphaunt/wasix';
const RUNTIME_PACKAGE = '@oliphaunt/liboliphaunt-wasix';
const NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function esmImportFrom(specifier) {
  return `from '${specifier}'`;
}

function manifestContract(manifest, label) {
  if (
    manifest.name !== PACKAGE_NAME
    || manifest.private === true
    || manifest.license !== releasePackageLicense().spdx
    || manifest.type !== 'module'
    || manifest.publishConfig?.access !== 'public'
    || manifest.publishConfig?.provenance !== true
  ) {
    fail(`${label} is not the public ESM ${PACKAGE_NAME} package`);
  }
  if (manifest.scripts !== undefined || manifest.devDependencies !== undefined) {
    fail(`${label} must not publish development scripts or dependencies`);
  }
  const dependencies = manifest.dependencies ?? {};
  if (
    typeof dependencies[RUNTIME_PACKAGE] !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(dependencies[RUNTIME_PACKAGE])
    || dependencies['@wasmer/sdk'] !== undefined
    || Object.keys(dependencies).some((name) => name === '@oliphaunt/ts' || name.includes('native'))
  ) {
    fail(`${label} must depend on the exact portable runtime and no stock/native host package`);
  }
  const root = manifest.exports?.['.'];
  if (
    root?.types !== './lib/index.d.ts'
    || root?.browser !== './lib/index.js'
    || root?.node !== './lib/index.node.js'
    || root?.default !== './lib/index.js'
  ) {
    fail(`${label} must expose exact browser and Node conditional entrypoints`);
  }
  if (
    manifest.oliphaunt?.runtimeProduct !== 'liboliphaunt-wasix'
    || manifest.oliphaunt?.runtimeVersion !== dependencies[RUNTIME_PACKAGE]
  ) {
    fail(`${label} runtime compatibility metadata differs from its exact dependency`);
  }
  return manifest;
}

export function prepareWasixTypescriptPackage(packageDir) {
  const root = path.resolve(packageDir);
  const manifestFile = path.join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const runtimeVersion = manifest.oliphaunt?.runtimeVersion;
  if (typeof runtimeVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(runtimeVersion)) {
    fail(`${PACKAGE_NAME} source manifest must declare an exact oliphaunt.runtimeVersion`);
  }
  const declaredRuntime = manifest.dependencies?.[RUNTIME_PACKAGE];
  if (declaredRuntime !== undefined && declaredRuntime !== runtimeVersion) {
    fail(`${PACKAGE_NAME} source runtime dependency conflicts with oliphaunt.runtimeVersion`);
  }
  manifest.dependencies = Object.fromEntries(
    Object.entries({ ...(manifest.dependencies ?? {}), [RUNTIME_PACKAGE]: runtimeVersion })
      .sort(([left], [right]) => compareText(left, right)),
  );
  delete manifest.devDependencies;
  delete manifest.scripts;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  stageReleaseNotices(root, NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(root, NOTICE_OPTIONS);
  manifestContract(manifest, `${PACKAGE_NAME} staged package.json`);
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
  for (const [name, entry] of entries) {
    if (entry.isSymbolicLink) fail(`${path.basename(file)} contains symbolic link ${name}`);
    if (
      entry.isFile
      && !name.startsWith('package/lib/')
      && !new Set([
        'package/package.json',
        'package/README.md',
        'package/ARCHITECTURE.md',
        'package/CHANGELOG.md',
        'package/LICENSE',
        'package/THIRD_PARTY_NOTICES.md',
      ]).has(name)
    ) {
      fail(`${path.basename(file)} contains unexpected package member ${name}`);
    }
  }
  const requireFile = (name) => {
    const entry = entries.get(`package/${name}`);
    if (!entry?.isFile || entry.isSymbolicLink || entry.size <= 0) {
      fail(`${path.basename(file)} is missing non-empty regular package/${name}`);
    }
    return Buffer.from(entry.data());
  };
  const manifest = manifestContract(
    JSON.parse(requireFile('package.json').toString('utf8')),
    `${path.basename(file)} package.json`,
  );
  for (const name of [
    'lib/index.js',
    'lib/index.node.js',
    'lib/node-client.js',
    'lib/node-worker.js',
    'lib/node-web-worker.js',
    'lib/node-web-worker-thread.js',
    'lib/worker.js',
    'lib/host/index.mjs',
    'lib/host/worker.mjs',
    'lib/host/wasmer_js_bg.wasm',
    'lib/host/provenance.json',
    'lib/host/LICENSE',
  ]) requireFile(name);
  const browserWorker = requireFile('lib/worker.js').toString('utf8');
  const nodeWorker = requireFile('lib/node-worker.js').toString('utf8');
  if (
    !browserWorker.includes(esmImportFrom('./host/index.mjs'))
    || !nodeWorker.includes(esmImportFrom('./node-host.js'))
    || browserWorker.includes('@wasmer/sdk')
    || nodeWorker.includes('@wasmer/sdk')
  ) {
    fail(`${path.basename(file)} workers do not resolve the package-relative patched host`);
  }
  JSON.parse(requireFile('lib/host/provenance.json').toString('utf8'));
  return manifest;
}
