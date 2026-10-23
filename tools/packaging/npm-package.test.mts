import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertExtensionUpstreamLicensesInArchive,
  stageExtensionUpstreamLicenses,
} from '../../src/extensions/tools/extension-upstream-licenses.mts';
import { npmArchiveFileMode, packGeneratedNpmCarrier } from './npm-package.mts';
import { listArchiveEntries } from './package-archive.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-npm-modes-'));
  const source = path.join(root, 'package');
  mkdirSync(path.join(source, 'bin'), { recursive: true });
  const manifest = {
    name: '@oliphaunt/mode-fixture',
    version: '1.0.0',
    repository: { type: 'git', url: 'git+https://github.com/f0rr0/oliphaunt.git' },
    publishConfig: { access: 'public', provenance: true, executableFiles: ['./bin/declared.exe'] },
  };
  const writeManifest = () =>
    writeFileSync(path.join(source, 'package.json'), `${JSON.stringify(manifest)}\n`);
  writeManifest();
  writeFileSync(path.join(source, 'bin/declared.exe'), 'declared executable bytes\n');
  t.after(() => {
    // Windows represents read-only staging files using the read-only attribute.
    for (const file of listArchiveEntries(source)) {
      if (statSync(file).isFile()) chmodSync(file, 0o666);
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, source, manifest, writeManifest };
}

test('npm archive modes ignore Windows synthetic bits and preserve Unix executability', () => {
  for (const mode of [0o444, 0o666, 0o777, 0o100666]) {
    assert.equal(npmArchiveFileMode(mode, false, 'win32'), 0o644);
    assert.equal(npmArchiveFileMode(mode, true, 'win32'), 0o755);
  }
  assert.equal(npmArchiveFileMode(0o444, false, 'linux'), 0o644);
  assert.equal(npmArchiveFileMode(0o666, false, 'darwin'), 0o644);
  assert.equal(npmArchiveFileMode(0o755, false, 'linux'), 0o755);
  assert.equal(npmArchiveFileMode(0o444, true, 'linux'), 0o755);
});

test('real npm carriers encode canonical legal/data and declared executable modes without chmod', (t) => {
  const { root, source } = fixture(t);
  stageExtensionUpstreamLicenses('pgtap', source);
  const license = path.join(source, 'share/licenses/pgtap/README.md');
  const writable = path.join(source, 'writable.txt');
  const readonly = path.join(source, 'readonly.txt');
  const unixExecutable = path.join(source, 'bin/unix-script');
  writeFileSync(writable, 'writable data\n');
  writeFileSync(readonly, 'read-only data\n');
  writeFileSync(unixExecutable, '#!/bin/sh\nexit 0\n');
  chmodSync(writable, 0o666);
  for (const file of [license, readonly, path.join(source, 'bin/declared.exe')])
    chmodSync(file, 0o444);
  chmodSync(unixExecutable, 0o755);
  const inputs = new Map(
    listArchiveEntries(source)
      .filter((file) => statSync(file).isFile())
      .map((file) => [file, { mode: statSync(file).mode, bytes: readFileSync(file) }]),
  );
  const tarball = packGeneratedNpmCarrier(source, path.join(root, 'tarballs'));
  const entries = readPortableArchiveEntries(tarball);
  for (const [name, entry] of entries) {
    const executable =
      name === 'package/bin/declared.exe' ||
      (process.platform !== 'win32' && name === 'package/bin/unix-script');
    assert.equal(entry.mode, entry.isDirectory || executable ? 0o755 : 0o644, name);
  }
  assert.deepEqual(
    assertExtensionUpstreamLicensesInArchive(['pgtap'], tarball, { prefix: 'package' }),
    ['package/share/licenses/pgtap/README.md'],
  );
  for (const [file, input] of inputs) {
    assert.equal(statSync(file).mode, input.mode, file);
    assert.deepEqual(readFileSync(file), input.bytes, file);
    const member = `package/${path.relative(source, file).split(path.sep).join('/')}`;
    assert.deepEqual(entries.get(member).data(), input.bytes, member);
  }
});

test('npm executable declarations must identify safe regular package files', (t) => {
  const { root, source, manifest, writeManifest } = fixture(t);
  const pack = () => packGeneratedNpmCarrier(source, path.join(root, 'tarballs'));
  for (const member of ['missing', 'bin', '../outside', '/absolute']) {
    manifest.publishConfig.executableFiles = [member];
    writeManifest();
    assert.throws(pack, /regular package file|unsafe archive member/u, member);
  }
  manifest.publishConfig.executableFiles = ['./bin/declared.exe'];
  writeManifest();
  const linked = path.join(source, 'linked');
  symlinkSync('bin/declared.exe', linked);
  assert.throws(pack, /only regular files and directories/u);
  rmSync(linked);
});
