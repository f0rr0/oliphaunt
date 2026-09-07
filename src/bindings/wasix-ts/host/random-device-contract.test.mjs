import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {loadHostBuildContract} from './build-provenance.mjs';

const hostUrl = new URL('./', import.meta.url);

function hostFile(path) {
  return readFile(new URL(path, hostUrl), 'utf8');
}

function additions(patch) {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('the pinned virtual-fs random device propagates entropy errors', async () => {
  const patchName = '0024-virtual-fs-propagate-random-errors.patch';
  const [{patchSeries, provenance, inputs}, patch] = await Promise.all([
    loadHostBuildContract(),
    hostFile(`patches/${patchName}`),
  ]);
  const added = additions(patch);

  assert.ok(patchSeries.includes(patchName));
  assert.ok(inputs.includes(`src/bindings/wasix-ts/host/patches/${patchName}`));
  assert.equal(provenance.virtualFsVersion, '0.601.0');
  assert.equal(provenance.randomDevice, 'virtual-fs-checked-getrandom');
  assert.match(added, /if let Err\(error\) = getrandom::getrandom\(&mut data\)/u);
  assert.match(added, /return Poll::Ready\(Err\(error\.into\(\)\)\)/u);
  assert.doesNotMatch(added, /getrandom::getrandom\(&mut data\)\.ok\(\)/u);
  assert.ok(
    patch.indexOf('return Poll::Ready(Err(error.into()))') < patch.indexOf('buf.put_slice(&data[..])'),
    'the failed read must return before advancing the destination buffer',
  );
});

test('the host build pins, patches, and selects the virtual-fs source', async () => {
  const [manifest, buildScript, rootPatch] = await Promise.all([
    hostFile('source.toml'),
    hostFile('build-sdk.sh'),
    hostFile('patches/0001-wasmer-js-run-configured-wasix-process.patch'),
  ]);

  assert.match(manifest, /\[virtual-fs\][\s\S]*version = "0\.601\.0"/u);
  assert.match(manifest, /sha256 = "8defc513ce70576bdbb4305ee67c0cba647af18c0995de8f1fa1271b724c9859"/u);
  assert.match(rootPatch, /virtual-fs = \{ path = "\.\.\/virtual-fs-0\.601\.0" \}/u);
  assert.match(buildScript, /"\$virtual_fs_url" --output "\$virtual_fs_archive"/u);
  assert.match(buildScript, /"\$virtual_fs_sha256  \$virtual_fs_archive".*--check --status/u);
  assert.match(buildScript, /\?\?\?\?-virtual-fs-\*\.patch\)[\s\S]*patch_dir="\$virtual_fs_dir"/u);
  assert.match(buildScript, /random device still discards entropy errors/u);
});
