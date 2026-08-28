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
const PACKAGE_NAME = '@oliphaunt/wasix-ts';
const RUNTIME_PACKAGE = '@oliphaunt/liboliphaunt-wasix';
const FZSTD_PACKAGE = 'fzstd';
const FZSTD_VERSION = '0.1.1';
const NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });

// One deliberate package contract is consumed by the source dry-run and the
// final archive verifier. Keep this explicit: it catches missing internal
// runtime/type dependencies without introducing a second module resolver.
export const WASIX_TYPESCRIPT_REQUIRED_PACKAGE_FILES = Object.freeze([
  'package.json',
  'README.md',
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'lib/archive.d.ts',
  'lib/archive.js',
  'lib/asset-source.d.ts',
  'lib/asset-source.js',
  'lib/byte-channel.d.ts',
  'lib/byte-channel.js',
  'lib/client-common.d.ts',
  'lib/client-common.js',
  'lib/client.d.ts',
  'lib/client.js',
  'lib/database-root.d.ts',
  'lib/database-root.js',
  'lib/database.d.ts',
  'lib/database.js',
  'lib/descriptor-validation.d.ts',
  'lib/descriptor-validation.js',
  'lib/direct-client-common.d.ts',
  'lib/direct-client-common.js',
  'lib/errors.d.ts',
  'lib/errors.js',
  'lib/extension-descriptor.d.ts',
  'lib/extension-descriptor.js',
  'lib/extensions.d.ts',
  'lib/extensions.js',
  'lib/host-runtime.d.ts',
  'lib/host-runtime.js',
  'lib/icu-descriptor.d.ts',
  'lib/icu-descriptor.js',
  'lib/host/LICENSE',
  'lib/host/index.d.mts',
  'lib/host/index.mjs',
  'lib/host/provenance.json',
  'lib/host/wasmer_js_bg.wasm',
  'lib/host/worker.mjs',
  'lib/index.bun.d.ts',
  'lib/index.bun.js',
  'lib/index.d.ts',
  'lib/index.deno.d.ts',
  'lib/index.deno.js',
  'lib/index.js',
  'lib/index.node.d.ts',
  'lib/index.node.js',
  'lib/internal-common.d.ts',
  'lib/internal-common.js',
  'lib/internal.d.ts',
  'lib/internal.js',
  'lib/internal.node.d.ts',
  'lib/internal.node.js',
  'lib/node-client.d.ts',
  'lib/node-client.js',
  'lib/node-client-common.d.ts',
  'lib/node-client-common.js',
  'lib/node-direct.d.ts',
  'lib/node-direct.js',
  'lib/node-directory-lock.d.ts',
  'lib/node-directory-lock.js',
  'lib/node-environment.d.ts',
  'lib/node-environment.js',
  'lib/node-fs-commit-state.d.ts',
  'lib/node-fs-commit-state.js',
  'lib/node-host.d.ts',
  'lib/node-host.js',
  'lib/node-tool-worker.d.ts',
  'lib/node-tool-worker.js',
  'lib/node-worker-options.d.ts',
  'lib/node-worker-options.js',
  'lib/node-worker-port.d.ts',
  'lib/node-worker-port.js',
  'lib/node-worker.d.ts',
  'lib/node-worker.js',
  'lib/node-zstd.d.ts',
  'lib/node-zstd.js',
  'lib/pgwire.d.ts',
  'lib/pgwire.js',
  'lib/pgwire-connection.d.ts',
  'lib/pgwire-connection.js',
  'lib/physical-archive.d.ts',
  'lib/physical-archive.js',
  'lib/protocol.d.ts',
  'lib/protocol.js',
  'lib/public.d.ts',
  'lib/public.js',
  'lib/query.d.ts',
  'lib/query.js',
  'lib/rpc.d.ts',
  'lib/rpc.js',
  'lib/runtime-descriptor.d.ts',
  'lib/runtime-descriptor.js',
  'lib/server.node.d.ts',
  'lib/server.node.js',
  'lib/startup-config.d.ts',
  'lib/startup-config.js',
  'lib/storage-provider.d.ts',
  'lib/storage-provider.js',
  'lib/storage-snapshot.d.ts',
  'lib/storage-snapshot.js',
  'lib/storage.d.ts',
  'lib/storage.js',
  'lib/storage/bun.d.ts',
  'lib/storage/bun.js',
  'lib/storage/deno.d.ts',
  'lib/storage/deno.js',
  'lib/storage/incremental-storage.d.ts',
  'lib/storage/incremental-storage.js',
  'lib/storage/indexed-db-provider.d.ts',
  'lib/storage/indexed-db-provider.js',
  'lib/storage/indexed-db.d.ts',
  'lib/storage/indexed-db.js',
  'lib/storage/node-directory-provider.d.ts',
  'lib/storage/node-directory-provider.js',
  'lib/storage/node.d.ts',
  'lib/storage/node.js',
  'lib/storage/opfs-provider.d.ts',
  'lib/storage/opfs-provider.js',
  'lib/storage/opfs-pool.d.ts',
  'lib/storage/opfs-pool.js',
  'lib/storage/opfs.d.ts',
  'lib/storage/opfs.js',
  'lib/storage/restore-cleanup.d.ts',
  'lib/storage/restore-cleanup.js',
  'lib/storage/web-lock.d.ts',
  'lib/storage/web-lock.js',
  'lib/types.d.ts',
  'lib/types.js',
  'lib/tool-runtime.d.ts',
  'lib/tool-runtime.js',
  'lib/tool-worker-common.d.ts',
  'lib/tool-worker-common.js',
  'lib/tool-worker.d.ts',
  'lib/tool-worker.js',
  'lib/wasix-runtime.d.ts',
  'lib/wasix-runtime.js',
  'lib/worker-client.d.ts',
  'lib/worker-client.js',
  'lib/worker-dispatch.d.ts',
  'lib/worker-dispatch.js',
  'lib/worker-entry.bun.d.ts',
  'lib/worker-entry.bun.js',
  'lib/worker-entry.deno.d.ts',
  'lib/worker-entry.deno.js',
  'lib/worker-entry.d.ts',
  'lib/worker-entry.js',
  'lib/worker-entry.node.d.ts',
  'lib/worker-entry.node.js',
  'lib/worker-node-client.d.ts',
  'lib/worker-node-client.js',
  'lib/worker-rpc.d.ts',
  'lib/worker-rpc.js',
  'lib/worker-transfer.d.ts',
  'lib/worker-transfer.js',
  'lib/worker.d.ts',
  'lib/worker.js',
  'lib/zstd.d.ts',
  'lib/zstd.js',
]);

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function esmImportFrom(specifier) {
  return `from '${specifier}'`;
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
  const expectedDependencies = [FZSTD_PACKAGE, RUNTIME_PACKAGE].sort(compareText);
  if (
    JSON.stringify(sortedKeys(dependencies)) !== JSON.stringify(expectedDependencies)
    || typeof dependencies[RUNTIME_PACKAGE] !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(dependencies[RUNTIME_PACKAGE])
    || dependencies[FZSTD_PACKAGE] !== FZSTD_VERSION
    || sortedKeys(manifest.optionalDependencies).length !== 0
    || sortedKeys(manifest.peerDependencies).length !== 0
    || manifest.peerDependenciesMeta !== undefined
    || manifest.bundledDependencies !== undefined
    || manifest.bundleDependencies !== undefined
  ) {
    fail(
      `${label} must depend only on the exact portable runtime and decompression packages`,
    );
  }
  const root = manifest.exports?.['.'];
  const expectedExports = [
    '.',
    './worker',
    './package.json',
    './internal/tools',
    './server/bun',
    './server/deno',
    './server/node',
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
  for (const runtime of ['node', 'bun', 'deno']) {
    const server = manifest.exports?.[`./server/${runtime}`];
    if (
      server?.types !== './lib/server.node.d.ts'
      || server?.[runtime] !== './lib/server.node.js'
      || sortedKeys(server).some((condition) => !['types', runtime].includes(condition))
    ) {
      fail(`${label} must expose the local server only under the ${runtime} condition`);
    }
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
  // The first-release changelog is intentionally empty and may be emitted as
  // a zero-byte member or omitted. Every released version still has to carry
  // the non-empty Release Please entry.
  const requiredPackageFiles = WASIX_TYPESCRIPT_REQUIRED_PACKAGE_FILES.filter(
    (name) => name !== 'CHANGELOG.md' || manifest.version !== '0.0.0',
  );
  const expectedFiles = new Set(
    WASIX_TYPESCRIPT_REQUIRED_PACKAGE_FILES.map((name) => `package/${name}`),
  );
  for (const [name, entry] of entries) {
    if (entry.isSymbolicLink) fail(`${path.basename(file)} contains symbolic link ${name}`);
    if (entry.isFile && !expectedFiles.has(name)) {
      fail(`${path.basename(file)} contains file outside the explicit package inventory: ${name}`);
    }
  }
  for (const name of requiredPackageFiles) requireFile(name);
  const browserWorker = requireFile('lib/worker.js').toString('utf8');
  const nodeWorker = requireFile('lib/node-worker.js').toString('utf8');
  const nodeDirect = requireFile('lib/node-direct.js').toString('utf8');
  if (
    !browserWorker.includes(esmImportFrom('./host/index.mjs'))
    || !nodeWorker.includes(esmImportFrom('./node-direct.js'))
    || !nodeDirect.includes(esmImportFrom('./node-host.js'))
    || browserWorker.includes('@wasmer/sdk')
    || nodeWorker.includes('@wasmer/sdk')
    || nodeDirect.includes('@wasmer/sdk')
  ) {
    fail(`${path.basename(file)} workers do not resolve the package-relative patched host`);
  }
  JSON.parse(requireFile('lib/host/provenance.json').toString('utf8'));
  return manifest;
}
