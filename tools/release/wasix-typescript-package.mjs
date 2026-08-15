import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const JSR_EXPORTS = Object.freeze({
  '.': './lib/index.deno.js',
  './protocol': './lib/protocol.js',
  './query': './lib/query.js',
  './storage/deno': './lib/storage/deno.js',
});
const JSR_ROOT_FILES = Object.freeze([
  'ARCHITECTURE.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'jsr.json',
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

function regularFilesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      const metadata = lstatSync(file);
      if (metadata.isSymbolicLink()) fail(`${root} contains symbolic link ${relative}`);
      if (metadata.isDirectory()) {
        visit(file);
      } else if (metadata.isFile()) {
        files.push(relative);
      } else {
        fail(`${root} contains unsupported file type ${relative}`);
      }
    }
  };
  visit(root);
  return files.sort(compareText);
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
  const nodeStorage = manifest.exports?.['./storage/node'];
  if (
    nodeStorage?.types !== './lib/storage/node.d.ts'
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

export function assertWasixTypescriptJsrDirectory(
  packageDir,
  { version: expectedVersion, runtimeVersion: expectedRuntimeVersion } = {},
) {
  const root = path.resolve(packageDir);
  assertReleaseNoticesInDirectory(root, NOTICE_OPTIONS);
  const jsrManifest = JSON.parse(readFileSync(path.join(root, 'jsr.json'), 'utf8'));
  const runtimeVersion = jsrManifest.oliphaunt?.runtimeVersion;
  if (
    jsrManifest.name !== PACKAGE_NAME
    || typeof jsrManifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(jsrManifest.version)
    || (expectedVersion !== undefined && jsrManifest.version !== expectedVersion)
    || jsrManifest.license !== releasePackageLicense().spdx
    || typeof runtimeVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(runtimeVersion)
    || (expectedRuntimeVersion !== undefined && runtimeVersion !== expectedRuntimeVersion)
    || JSON.stringify(jsrManifest.exports) !== JSON.stringify(JSR_EXPORTS)
    || JSON.stringify(jsrManifest.imports) !== JSON.stringify({
      [RUNTIME_PACKAGE]: `npm:${RUNTIME_PACKAGE}@${runtimeVersion}`,
      [FZSTD_PACKAGE]: `npm:${FZSTD_PACKAGE}@${FZSTD_VERSION}`,
    })
  ) {
    fail(`${PACKAGE_NAME} staged JSR manifest has incorrect identity, exports, or imports`);
  }
  const include = jsrManifest.publish?.include;
  if (
    !Array.isArray(include)
    || include.length === 0
    || include.some((member) => typeof member !== 'string' || member.length === 0)
    || new Set(include).size !== include.length
    || include.some((member) => member.includes('\\') || /[*?\[\]{}]/u.test(member))
  ) {
    fail(`${PACKAGE_NAME} JSR publish.include must contain unique explicit regular files`);
  }
  const files = regularFilesUnder(root);
  if (JSON.stringify([...include].sort(compareText)) !== JSON.stringify(files)) {
    fail(`${PACKAGE_NAME} JSR publish.include must exactly cover its staged package files`);
  }
  for (const member of JSR_ROOT_FILES) {
    if (!include.includes(member)) fail(`${PACKAGE_NAME} JSR publish.include omits ${member}`);
  }
  for (const target of Object.values(JSR_EXPORTS)) {
    const member = target.replace(/^\.\//u, '');
    if (!include.includes(member)) fail(`${PACKAGE_NAME} JSR publish.include omits export ${member}`);
  }
  return jsrManifest;
}

export function prepareWasixTypescriptJsrPackage(packageDir) {
  const root = path.resolve(packageDir);
  const packageManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const jsrManifestFile = path.join(root, 'jsr.json');
  const jsrManifest = JSON.parse(readFileSync(jsrManifestFile, 'utf8'));
  const runtimeVersion = packageManifest.dependencies?.[RUNTIME_PACKAGE];
  if (
    typeof runtimeVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(runtimeVersion)
    || jsrManifest.oliphaunt?.runtimeVersion !== runtimeVersion
  ) {
    fail(`${PACKAGE_NAME} source JSR manifest must bind the staged portable runtime version`);
  }
  jsrManifest.imports = {
    [RUNTIME_PACKAGE]: `npm:${RUNTIME_PACKAGE}@${runtimeVersion}`,
    [FZSTD_PACKAGE]: `npm:${FZSTD_PACKAGE}@${FZSTD_VERSION}`,
  };
  writeFileSync(jsrManifestFile, `${JSON.stringify(jsrManifest, null, 2)}\n`);
  return jsrManifest;
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
  const manifest = assertWasixTypescriptManifest(
    JSON.parse(requireFile('package.json').toString('utf8')),
    `${path.basename(file)} package.json`,
  );
  for (const name of [
    'lib/index.js',
    'lib/index.bun.js',
    'lib/index.deno.js',
    'lib/index.node.js',
    'lib/node-client.js',
    'lib/node-directory-lock.js',
    'lib/node-lock-identity.js',
    'lib/node-worker.js',
    'lib/node-worker-options.js',
    'lib/node-zstd.js',
    'lib/node-web-worker.js',
    'lib/node-web-worker-thread.js',
    'lib/server-runtime.js',
    'lib/storage/bun.js',
    'lib/storage/deno.js',
    'lib/storage/node.js',
    'lib/storage/node-directory-provider.js',
    'lib/zstd.js',
    'lib/worker.js',
    'lib/host/index.mjs',
    'lib/host/worker.mjs',
    'lib/host/wasmer_js_bg.wasm',
    'lib/host/provenance.json',
    'lib/host/LICENSE',
  ]) requireFile(name);
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
