import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readPortableArchiveEntries } from '../../../../shared/artifact-packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../../shared/artifact-packaging/release-notices.mts';
import { nativeIcuDataManifest } from '../../../../shared/cluster-seed-contract/icu-data.mts';
import {
  assertIcuPackageManifest,
  assertIcuPackedDataMatchesSource,
  assertIcuPackedInventory,
  assertPackedIcuCarrier,
  ICU_DATA_RELATIVE_PATH,
  ICU_MANIFEST_RELATIVE_PATH,
} from './icu-npm-carrier-contract.mts';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const ICU_PACKAGE_ROOT = path.join(ROOT, 'src/runtimes/liboliphaunt/native/icu-npm');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const manifest = JSON.parse(readFileSync(path.join(ICU_PACKAGE_ROOT, 'package.json'), 'utf8'));
const stagedManifest = {
  ...manifest,
  oliphaunt: { ...manifest.oliphaunt, icuDataTreeSha256: 'a'.repeat(64) },
};
const config = readFileSync(path.join(ICU_PACKAGE_ROOT, 'react-native.config.cts'));
const podspec = readFileSync(path.join(ICU_PACKAGE_ROOT, 'OliphauntICU.podspec'));
const canonicalEntries = [
  { name: 'package/package.json', isFile: true },
  { name: 'package/react-native.config.js', isFile: true },
  { name: 'package/OliphauntICU.podspec', isFile: true },
  { name: 'package/OliphauntICU.bundle/', isFile: false },
  { name: 'package/OliphauntICU.bundle/share/icu/icudt77l/root.res', isFile: true },
  { name: 'package/OliphauntICU.bundle/manifest.properties', isFile: true },
];

function stageIcuReceipt(root) {
  const data = path.join(root, ...ICU_DATA_RELATIVE_PATH.split('/'));
  const receipt = nativeIcuDataManifest(data);
  writeFileSync(path.join(root, ...ICU_MANIFEST_RELATIVE_PATH.split('/')), receipt);
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  packageJson.oliphaunt.icuDataTreeSha256 = /^icuDataTreeSha256=([0-9a-f]{64})$/mu.exec(
    receipt.toString('utf8'),
  )[1];
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
}

test('ICU npm pack includes one canonical bundle and preserves both native descriptors byte-for-byte', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-icu-npm-contract-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage');
  const output = path.join(root, 'packed');
  cpSync(ICU_PACKAGE_ROOT, stage, { recursive: true });
  writeFileSync(path.join(stage, 'react-native.config.js'), config);
  mkdirSync(path.join(stage, ...ICU_DATA_RELATIVE_PATH.split('/'), 'icudt-test'), {
    recursive: true,
  });
  writeFileSync(
    path.join(stage, ...ICU_DATA_RELATIVE_PATH.split('/'), 'icudt-test', 'root.res'),
    'fixture\n',
  );
  stageIcuReceipt(stage);
  stageReleaseNotices(stage, { profile: 'native-icu-data' });
  mkdirSync(output);
  const packed = spawnSync(PNPM, ['pack', '--pack-destination', output, '--json'], {
    cwd: stage,
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const packedRows = JSON.parse(packed.stdout);
  const row = Array.isArray(packedRows) ? packedRows[0] : packedRows;
  const tarball = path.isAbsolute(row.filename)
    ? row.filename
    : path.join(output, path.basename(row.filename));
  const entries = readPortableArchiveEntries(tarball);
  const consumer = path.join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, 'package.json'), entries.get('package/package.json').data());
  const packedConfigFile = path.join(consumer, 'react-native.config.js');
  writeFileSync(packedConfigFile, entries.get('package/react-native.config.js').data());
  const loaded = spawnSync(
    'node',
    ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', packedConfigFile],
    { encoding: 'utf8' },
  );
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(JSON.parse(loaded.stdout), {
    dependency: { platforms: { ios: null, android: null } },
  });
  assert.equal(entries.has('package/share/icu/icudt-test/root.res'), false);
  assert.equal(entries.has('package/OliphauntICU.bundle/share/icu/icudt-test/root.res'), true);
  assertPackedIcuCarrier({
    entries: [...entries].map(([name, entry]) => ({ name, isFile: entry.isFile })),
    packageJson: JSON.parse(
      Buffer.from(entries.get('package/package.json').data()).toString('utf8'),
    ),
    packedConfig: Buffer.from(entries.get('package/react-native.config.js').data()),
    packedPodspec: Buffer.from(entries.get('package/OliphauntICU.podspec').data()),
    sourceConfig: config,
    sourcePodspec: podspec,
  });
  const sourceEntries = new Map([
    [
      'share/icu/icudt-test/root.res',
      {
        data: () => Buffer.from('fixture\n'),
        isFile: true,
        size: Buffer.byteLength('fixture\n'),
      },
    ],
  ]);
  assert.doesNotThrow(() =>
    assertIcuPackedDataMatchesSource({
      packedEntries: entries,
      sourceEntries,
    }),
  );
  assert.throws(
    () =>
      assertIcuPackedDataMatchesSource({
        packedEntries: entries,
        sourceEntries: new Map([
          [
            'share/icu/icudt-test/root.res',
            {
              data: () => Buffer.from('changed\n'),
              isFile: true,
              size: Buffer.byteLength('changed\n'),
            },
          ],
        ]),
      }),
    /ICU data differs/u,
  );

  const tar = gunzipSync(readFileSync(tarball));
  const firstSize = Number.parseInt(
    tar.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim() || '0',
    8,
  );
  const firstSpan = 512 + Math.ceil(firstSize / 512) * 512;
  let endOffset = 0;
  while (endOffset + 512 <= tar.length) {
    const header = tar.subarray(endOffset, endOffset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim() || '0',
      8,
    );
    endOffset += 512 + Math.ceil(size / 512) * 512;
  }
  const duplicateArchive = path.join(root, 'duplicate-member.tgz');
  writeFileSync(
    duplicateArchive,
    gzipSync(
      Buffer.concat([
        tar.subarray(0, endOffset),
        tar.subarray(0, firstSpan),
        tar.subarray(endOffset),
      ]),
    ),
  );
  assert.throws(() => readPortableArchiveEntries(duplicateArchive), /repeats archive member/u);
});

test('ICU npm manifest rejects ESM autolinking and the legacy payload selector', () => {
  assert.throws(
    () => assertIcuPackageManifest({ ...stagedManifest, type: 'module' }),
    /type must be "commonjs"/u,
  );
  assert.throws(
    () => assertIcuPackageManifest({ ...stagedManifest, files: [...manifest.files, 'share'] }),
    /must not include the legacy ICU tree/u,
  );
});

test('ICU packed inventory accepts one data-only bundle and rejects legacy, additional, or duplicate trees', () => {
  assert.doesNotThrow(() => assertIcuPackedInventory(canonicalEntries));
  assert.throws(
    () =>
      assertIcuPackedInventory([
        ...canonicalEntries,
        { name: 'package/share/icu/icudt77l/root.res', isFile: true },
      ]),
    /forbidden legacy ICU data member/u,
  );
  assert.throws(
    () =>
      assertIcuPackedInventory([
        ...canonicalEntries,
        { name: 'package/duplicate/share/icu/icudt77l/root.res', isFile: true },
      ]),
    /unexpected additional ICU data tree/u,
  );
  assert.throws(
    () => assertIcuPackedInventory([...canonicalEntries, canonicalEntries.at(-1)]),
    /repeats member/u,
  );
});

test('ICU packed carrier preserves the reviewed config and podspec bytes exactly', () => {
  assert.throws(
    () =>
      assertPackedIcuCarrier({
        entries: canonicalEntries,
        packageJson: stagedManifest,
        packedConfig: Buffer.concat([config, Buffer.from('\n')]),
        packedPodspec: podspec,
        sourceConfig: config,
        sourcePodspec: podspec,
      }),
    /packed bytes differ from the reviewed source descriptor/u,
  );
  assert.throws(
    () =>
      assertPackedIcuCarrier({
        entries: canonicalEntries,
        packageJson: stagedManifest,
        packedConfig: config,
        packedPodspec: Buffer.concat([podspec, Buffer.from('\n')]),
        sourceConfig: config,
        sourcePodspec: podspec,
      }),
    /packed bytes differ from the reviewed source descriptor/u,
  );
});
