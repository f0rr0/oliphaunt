import path from 'node:path';

import { prepareWasixToolsTypescriptPackage as prepareProductPackage } from '../../src/bindings/wasix-ts/tools-package/tools/package.mjs';

import { validateNpmTrustedPublishingManifest } from './npm-trusted-publishing.mjs';
import { readPortableArchiveEntries } from '../../src/shared/artifact-packaging/portable-archive.mjs';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releasePackageLicense,
  stageReleaseNotices,
} from './release-notices.mjs';

const TOOL = 'wasix-tools-typescript-package.mjs';
const PACKAGE_NAME = '@oliphaunt/wasix-tools';
const TOOLS_CARRIER = '@oliphaunt/liboliphaunt-wasix-tools';
const WASIX_BINDING = '@oliphaunt/wasix-ts';
const NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

export function prepareWasixToolsTypescriptPackage(packageDir, bindingVersion) {
  const root = path.resolve(packageDir);
  const manifest = prepareProductPackage(root, bindingVersion);
  stageReleaseNotices(root, NOTICE_OPTIONS);
  assertReleaseNoticesInDirectory(root, NOTICE_OPTIONS);
  assertWasixToolsTypescriptManifest(manifest, `${PACKAGE_NAME} staged package`);
  return manifest;
}

export function assertWasixToolsTypescriptManifest(manifest, label = PACKAGE_NAME) {
  validateNpmTrustedPublishingManifest(manifest, label);
  if (
    manifest.name !== PACKAGE_NAME ||
    !EXACT_VERSION.test(manifest.version) ||
    manifest.private === true ||
    manifest.license !== releasePackageLicense().spdx ||
    manifest.type !== 'module' ||
    manifest.scripts !== undefined ||
    manifest.devDependencies !== undefined
  ) {
    fail(`${label} is not the exact public source-only tools package`);
  }
  const dependencies = manifest.dependencies ?? {};
  const peerDependencies = manifest.peerDependencies ?? {};
  if (
    JSON.stringify(Object.keys(dependencies)) !== JSON.stringify([TOOLS_CARRIER]) ||
    !EXACT_VERSION.test(dependencies[TOOLS_CARRIER]) ||
    JSON.stringify(Object.keys(peerDependencies)) !== JSON.stringify([WASIX_BINDING]) ||
    peerDependencies[WASIX_BINDING] !== manifest.version ||
    manifest.oliphaunt?.runtimeProduct !== 'liboliphaunt-wasix' ||
    manifest.oliphaunt?.runtimeVersion !== dependencies[TOOLS_CARRIER] ||
    Object.keys(manifest.optionalDependencies ?? {}).length > 0
  ) {
    fail(`${label} must depend on the exact tools carrier and peer with its exact WASIX binding`);
  }
  if (
    manifest.exports?.['.']?.types !== './lib/index.d.ts' ||
    manifest.exports?.['.']?.default !== './lib/index.js' ||
    manifest.exports?.['./package.json'] !== './package.json'
  ) {
    fail(`${label} exports differ from the two-function public package surface`);
  }
  return manifest;
}

export function assertWasixToolsTypescriptNpmArchive(archive) {
  const file = path.resolve(archive);
  assertReleaseNoticesInArchive(file, { ...NOTICE_OPTIONS, prefix: 'package' });
  const entries = readPortableArchiveEntries(file);
  const manifest = assertWasixToolsTypescriptManifest(
    JSON.parse(required(entries, 'package/package.json').toString('utf8')),
    `${path.basename(file)} package.json`,
  );
  if (
    JSON.stringify([...(manifest.files ?? [])].sort()) !==
    JSON.stringify(['CHANGELOG.md', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'lib'])
  ) {
    fail(`${file} package.json files differ from the owned package roots`);
  }
  const allowed = new Set(['package.json', ...manifest.files.filter((name) => name !== 'lib')]);
  for (const [name, entry] of entries) {
    if (entry.isSymbolicLink) fail(`${file} contains symbolic link ${name}`);
    const relative = name.replace(/^package\//u, '');
    if (entry.isFile && !allowed.has(relative) && !relative.startsWith('lib/')) {
      fail(`${file} contains file outside package.json files: ${name}`);
    }
  }
  for (const name of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'lib/index.d.ts', 'lib/index.js']) {
    required(entries, `package/${name}`);
  }
  for (const name of ['CHANGELOG.md']) {
    if (name === 'CHANGELOG.md' && manifest.version === '0.0.0') continue;
    required(entries, `package/${name}`);
  }
  return manifest;
}

function required(entries, member) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`package is missing non-empty regular ${member}`);
  }
  return Buffer.from(entry.data());
}
