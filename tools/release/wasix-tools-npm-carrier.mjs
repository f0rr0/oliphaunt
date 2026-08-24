#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import { captureCommandOutput } from '../dev/capture-command-output.mjs';
import { validatePortableReleaseAsset } from './check-liboliphaunt-wasix-release-assets.mjs';
import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustedPublishingManifest,
} from './npm-trusted-publishing.mjs';
import { readPortableArchiveEntries } from './portable-archive.mjs';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from './release-notices.mjs';

const TOOL = 'wasix-tools-npm-carrier.mjs';
const ROOT = path.resolve(import.meta.dirname, '../..');
const PACKAGE_NAME = '@oliphaunt/liboliphaunt-wasix-tools';
const DESCRIPTOR_SCHEMA = 'oliphaunt-wasix-tools-v1';
const RELEASE_TOOLS = Object.freeze({
  pgDump: Object.freeze({ name: 'pg_dump', member: 'target/oliphaunt-wasix/assets/bin/pg_dump.wasix.wasm' }),
  psql: Object.freeze({ name: 'psql', member: 'target/oliphaunt-wasix/assets/bin/psql.wasix.wasm' }),
});
const NOTICE_OPTIONS = Object.freeze({ profile: 'wasix-runtime' });

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requiredEntry(entries, member, label) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${label} must contain ${member} as a non-empty regular file`);
  }
  return Buffer.from(entry.data());
}

function regularArchive(file) {
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
      fail(`${file} must be a non-empty regular non-symlink archive`);
    }
  } catch (cause) {
    fail(`${file} cannot be inspected: ${cause.message}`);
  }
}

export function wasixToolsNpmInputs({ portableReleaseArchive }) {
  const archive = path.resolve(portableReleaseArchive);
  regularArchive(archive);
  validatePortableReleaseAsset(archive);
  const entries = readPortableArchiveEntries(archive);
  const tools = {};
  for (const [descriptorName, spec] of Object.entries(RELEASE_TOOLS)) {
    const bytes = requiredEntry(entries, spec.member, archive);
    tools[descriptorName] = Object.freeze({
      name: spec.name,
      sha256: sha256(bytes),
      size: bytes.length,
      bytes,
    });
  }
  return Object.freeze(tools);
}

export function stageWasixToolsNpmCarrier({ version, portableReleaseArchive, packageDir }) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new TypeError(`${TOOL}: version must be an exact semantic version`);
  }
  const output = path.resolve(packageDir);
  const tools = wasixToolsNpmInputs({ portableReleaseArchive });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(output, 'assets'), { recursive: true });
  for (const [name, tool] of Object.entries(tools)) {
    const filename = name === 'pgDump' ? 'pg_dump.wasix.wasm' : 'psql.wasix.wasm';
    writeFileSync(path.join(output, 'assets', filename), tool.bytes, { mode: 0o644 });
  }
  const descriptor = Object.freeze({ version, runtimeVersion: version, ...tools });
  writeFileSync(path.join(output, 'index.js'), renderDescriptor(descriptor), { mode: 0o644 });
  writeFileSync(path.join(output, 'index.d.ts'), renderTypes(), { mode: 0o644 });
  writeFileSync(
    path.join(output, 'README.md'),
    `# ${PACKAGE_NAME}\n\nPortable PostgreSQL \`pg_dump\` and \`psql\` modules used by \`@oliphaunt/wasix-tools\`. Application code should depend on the facade rather than this asset carrier.\n`,
    { mode: 0o644 },
  );
  stageReleaseNotices(output, NOTICE_OPTIONS);
  const notices = releaseNoticeRows(NOTICE_OPTIONS).map(({ member }) => member);
  const manifest = {
    name: PACKAGE_NAME,
    version,
    description: 'Portable WASIX pg_dump and psql modules for Oliphaunt hosts.',
    license: releaseProfilePackageLicense('wasix-runtime').spdx,
    type: 'module',
    sideEffects: false,
    repository: { type: 'git', url: NPM_TRUSTED_PUBLISHING_REPOSITORY },
    oliphaunt: {
      product: 'liboliphaunt-wasix',
      kind: 'wasix-tools',
      runtime: 'wasix',
      target: 'portable',
      runtimeVersion: version,
      descriptorSchema: DESCRIPTOR_SCHEMA,
    },
    publishConfig: { access: 'public', provenance: true },
    files: ['README.md', 'index.js', 'index.d.ts', 'assets', ...notices],
    exports: {
      '.': { types: './index.d.ts', import: './index.js', default: './index.js' },
      './package.json': './package.json',
    },
  };
  validateNpmTrustedPublishingManifest(manifest, `${PACKAGE_NAME} generated package`);
  writeFileSync(path.join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  assertReleaseNoticesInDirectory(output, NOTICE_OPTIONS);
  return Object.freeze({ packageDir: output, descriptor });
}

export function packWasixToolsNpmCarrier({
  version,
  portableReleaseArchive,
  packageDir = path.join(ROOT, 'target/release/npm-package-sources/liboliphaunt-wasix-tools'),
  tarballRoot = path.join(ROOT, 'target/release/npm-packages/liboliphaunt-wasix-tools'),
}) {
  const staged = stageWasixToolsNpmCarrier({ version, portableReleaseArchive, packageDir });
  const output = path.resolve(tarballRoot);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = captureCommandOutput(
    command,
    ['pack', '--pack-destination', output, '--json'],
    { cwd: staged.packageDir, label: `pnpm pack for ${PACKAGE_NAME}`, maxOutputBytes: 4 * 1024 * 1024 },
  );
  if (result.error !== undefined || result.status !== 0) {
    fail(`pnpm pack failed: ${String(result.stderr || result.error?.message || '').trim()}`);
  }
  const packed = JSON.parse(result.stdout);
  const filename = Array.isArray(packed) ? packed[0]?.filename : packed?.filename;
  if (typeof filename !== 'string') fail('pnpm pack did not report its filename');
  const tarball = path.isAbsolute(filename) ? filename : path.join(output, filename);
  assertWasixToolsNpmArchive(tarball, staged.descriptor);
  return Object.freeze({ ...staged, tarball });
}

export function assertWasixToolsNpmArchive(archive, descriptor) {
  if (statSync(archive).size > 20 * 1024 * 1024) fail(`${archive} exceeds the package size limit`);
  assertReleaseNoticesInArchive(archive, { ...NOTICE_OPTIONS, prefix: 'package' });
  const entries = readPortableArchiveEntries(archive);
  const expected = [
    'package/package.json',
    'package/README.md',
    'package/index.js',
    'package/index.d.ts',
    'package/assets/pg_dump.wasix.wasm',
    'package/assets/psql.wasix.wasm',
    ...releaseNoticeRows(NOTICE_OPTIONS).map(({ member }) => `package/${member}`),
  ].sort();
  const actual = [...entries]
    .filter(([, entry]) => entry.isFile)
    .map(([member]) => member)
    .sort();
  if (!isDeepStrictEqual(actual, expected)) fail(`${archive} file inventory differs from its allowlist`);
  const manifest = JSON.parse(
    requiredEntry(entries, 'package/package.json', archive).toString('utf8'),
  );
  validateNpmTrustedPublishingManifest(manifest, `${archive} package.json`);
  if (manifest.name !== PACKAGE_NAME || manifest.version !== descriptor.version) {
    fail(`${archive} has the wrong package identity`);
  }
  for (const [name, tool] of Object.entries({
    'pg_dump.wasix.wasm': descriptor.pgDump,
    'psql.wasix.wasm': descriptor.psql,
  })) {
    const bytes = requiredEntry(entries, `package/assets/${name}`, archive);
    if (bytes.length !== tool.size || sha256(bytes) !== tool.sha256) {
      fail(`${archive} contains unexpected ${name} bytes`);
    }
  }
  return manifest;
}

function renderDescriptor(descriptor) {
  const tool = (name, value) => `Object.freeze({ name: ${JSON.stringify(value.name)}, sha256: ${JSON.stringify(value.sha256)}, size: ${value.size}, source: new URL('./assets/${name}.wasix.wasm', import.meta.url).href })`;
  return `export default Object.freeze({\n  schema: '${DESCRIPTOR_SCHEMA}',\n  product: 'oliphaunt-wasix-tools',\n  version: ${JSON.stringify(descriptor.version)},\n  runtimeProduct: 'liboliphaunt-wasix',\n  runtimeVersion: ${JSON.stringify(descriptor.runtimeVersion)},\n  pgDump: ${tool('pg_dump', descriptor.pgDump)},\n  psql: ${tool('psql', descriptor.psql)},\n});\n`;
}

function renderTypes() {
  return `export type WasixToolModule = Readonly<{ name: 'pg_dump' | 'psql'; sha256: string; size: number; source: string }>;\nexport type WasixToolsDescriptor = Readonly<{ schema: '${DESCRIPTOR_SCHEMA}'; product: 'oliphaunt-wasix-tools'; version: string; runtimeProduct: 'liboliphaunt-wasix'; runtimeVersion: string; pgDump: WasixToolModule; psql: WasixToolModule }>;\ndeclare const descriptor: WasixToolsDescriptor;\nexport default descriptor;\n`;
}
