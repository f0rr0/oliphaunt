import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { archiveDirectory as writeArchive } from '../../../../tools/packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../../tools/packaging/release-notices.mts';
import {
  assertNodeDirectNpmArchive,
  assertNodeDirectReleaseNoticeEntries,
} from './check-release-assets.mts';
import {
  assertRustDependencyLicensesInEntries,
  RUST_PAYLOAD_LICENSE,
  rustDependencyLicenseMembers,
  stageRustDependencyLicenses,
} from './dependency-license-contract.mts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const TARGET = Object.freeze({
  npmPackage: '@oliphaunt/node-direct-linux-x64-gnu',
  target: 'linux-x64-gnu',
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'node-direct-notices-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function archiveDirectory(source, output, { keepParent = false } = {}) {
  const archive =
    output.endsWith('.tar.gz') || output.endsWith('.zip') ? output : `${output}.tar.gz`;
  await writeArchive(source, archive, { keepParent });
  if (archive !== output) renameSync(archive, output);
}

function stageNpmPackage(root) {
  const packageDir = path.join(root, 'package');
  mkdirSync(path.join(packageDir, 'prebuilds'), { recursive: true });
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'sdks/ts/node-addon/packages/linux-x64-gnu/package.json'), 'utf8'),
  );
  writeFileSync(path.join(packageDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(packageDir, 'prebuilds/oliphaunt_node.node'), 'fixture-addon\n');
  stageReleaseNotices(packageDir, { profile: 'source-sdk' });
  stageRustDependencyLicenses(packageDir, TARGET.target);
  return { manifest, packageDir };
}

test('Node direct addon and npm carriers preserve source and compiled dependency licenses', async (t) => {
  const root = fixture(t);
  const addonStage = path.join(root, 'addon');
  mkdirSync(addonStage);
  writeFileSync(path.join(addonStage, 'oliphaunt_node.node'), 'fixture-addon\n');
  stageReleaseNotices(addonStage, { profile: 'source-sdk' });
  stageRustDependencyLicenses(addonStage, TARGET.target);
  const addonArchive = path.join(root, 'addon.tar.gz');
  await archiveDirectory(addonStage, addonArchive);
  assert.deepEqual(
    assertNodeDirectReleaseNoticeEntries(readPortableArchiveEntries(addonArchive), {
      label: path.basename(addonArchive),
    }),
    ['LICENSE', 'THIRD_PARTY_NOTICES.md'],
  );
  const addonZip = path.join(root, 'addon.zip');
  await archiveDirectory(addonStage, addonZip);
  assert.deepEqual(
    assertNodeDirectReleaseNoticeEntries(readPortableArchiveEntries(addonZip), {
      label: path.basename(addonZip),
    }),
    ['LICENSE', 'THIRD_PARTY_NOTICES.md'],
  );

  for (const file of [addonArchive, addonZip]) {
    assertRustDependencyLicensesInEntries(readPortableArchiveEntries(file), {
      target: TARGET.target,
      label: file,
    });
  }
  const { manifest: sourceManifest, packageDir } = stageNpmPackage(root);
  const npmArchive = path.join(root, 'node-direct.tgz');
  await archiveDirectory(packageDir, npmArchive, { keepParent: true });
  const manifest = assertNodeDirectNpmArchive(npmArchive, [TARGET], sourceManifest.version);
  assert.equal(manifest.license, RUST_PAYLOAD_LICENSE);
});

test('Node direct npm validation rejects notice drift and runtime-license carryover', async (t) => {
  const root = fixture(t);
  let staged = stageNpmPackage(path.join(root, 'byte-drift'));
  writeFileSync(path.join(staged.packageDir, 'LICENSE'), 'not canonical\n');
  let archive = path.join(root, 'byte-drift.tgz');
  await archiveDirectory(staged.packageDir, archive, { keepParent: true });
  assert.throws(
    () => assertNodeDirectNpmArchive(archive, [TARGET], staged.manifest.version),
    /differs byte-for-byte/u,
  );

  staged = stageNpmPackage(path.join(root, 'stale-runtime'));
  writeFileSync(
    path.join(staged.packageDir, 'package.json'),
    `${JSON.stringify(staged.manifest, null, 2)}\n`,
  );
  rmSync(path.join(staged.packageDir, 'THIRD_PARTY_LICENSES/rust'), { recursive: true });
  stageReleaseNotices(staged.packageDir, { profile: 'native-runtime' });
  archive = path.join(root, 'stale-runtime.tgz');
  await archiveDirectory(staged.packageDir, archive, { keepParent: true });
  assert.throws(
    () => assertNodeDirectNpmArchive(archive, [TARGET], staged.manifest.version),
    /unexpected (?:product notice|release license)/u,
  );

  staged = stageNpmPackage(path.join(root, 'mode-drift'));
  chmodSync(path.join(staged.packageDir, 'THIRD_PARTY_NOTICES.md'), 0o755);
  archive = path.join(root, 'mode-drift.tgz');
  await archiveDirectory(staged.packageDir, archive, { keepParent: true });
  assert.throws(
    () => assertNodeDirectNpmArchive(archive, [TARGET], staged.manifest.version),
    /mode 0644/u,
  );
});

test('Node direct npm rejects missing and modified compiled dependency licenses', async (t) => {
  const root = fixture(t);
  for (const mutation of ['missing', 'modified']) {
    const { manifest, packageDir } = stageNpmPackage(path.join(root, mutation));
    const member = rustDependencyLicenseMembers(TARGET.target).find((name) =>
      name.includes('/licenses/'),
    );
    assert.ok(member);
    const file = path.join(packageDir, member);
    if (mutation === 'missing') rmSync(file);
    else writeFileSync(file, 'wrong copyright holder\n');
    const archive = path.join(root, mutation + '.tgz');
    await archiveDirectory(packageDir, archive, { keepParent: true });
    assert.throws(
      () => assertNodeDirectNpmArchive(archive, [TARGET], manifest.version),
      /(?:missing regular dependency license|differs from canonical bytes)/u,
    );
  }
});
