import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { validateNpmTrustedPublishingManifest } from './npm-trusted-publishing.mjs';
import { readPortableArchiveEntries } from './portable-archive.mjs';
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

export const WASIX_TOOLS_TYPESCRIPT_REQUIRED_FILES = Object.freeze([
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'lib/index.d.ts',
  'lib/index.js',
]);

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

export function prepareWasixToolsTypescriptPackage(packageDir, bindingVersion) {
  const root = path.resolve(packageDir);
  const manifestFile = path.join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!EXACT_VERSION.test(bindingVersion)) fail('binding version must be exact');
  manifest.version = bindingVersion;
  manifest.dependencies = {
    [TOOLS_CARRIER]: manifest.oliphaunt?.runtimeVersion,
  };
  manifest.peerDependencies = {
    [WASIX_BINDING]: bindingVersion,
  };
  delete manifest.scripts;
  delete manifest.devDependencies;
  stageReleaseNotices(root, NOTICE_OPTIONS);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
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
  const expected = new Set(WASIX_TOOLS_TYPESCRIPT_REQUIRED_FILES.map((name) => `package/${name}`));
  for (const [name, entry] of entries) {
    if (entry.isSymbolicLink) fail(`${file} contains symbolic link ${name}`);
    if (entry.isFile && !expected.has(name)) fail(`${file} contains unexpected file ${name}`);
  }
  for (const name of WASIX_TOOLS_TYPESCRIPT_REQUIRED_FILES) {
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
