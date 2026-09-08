import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadHostBuildContract } from './build-provenance.mjs';

const hostUrl = new URL('./', import.meta.url);
const patchName = '0027-wasmer-wasix-isolate-thread-local-handle-borrows.patch';

function additions(patch) {
  return patch
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');
}

test('thread-local cleanup is independent and callback handle conflicts are fallible', async () => {
  const [{ patchSeries, inputs }, patch, buildScript] = await Promise.all([
    loadHostBuildContract(),
    readFile(new URL(`patches/${patchName}`, hostUrl), 'utf8'),
    readFile(new URL('build-sdk.sh', hostUrl), 'utf8'),
  ]);
  const added = additions(patch);

  assert.equal(
    patchSeries.filter(candidate => candidate === patchName).length,
    1,
    'the standalone lifetime fix must appear exactly once in the host series',
  );
  assert.ok(inputs.includes(`src/bindings/wasix-ts/host/patches/${patchName}`));
  assert.match(added, /fn clone_registered<T>/u);
  assert.match(added, /registry\.borrow\(\)\.get\(&id\)\.cloned\(\)/u);
  assert.match(added, /inner\.try_borrow\(\)\.ok\(\)\?/u);
  assert.match(added, /inner\.try_borrow_mut\(\)\.ok\(\)\?/u);
  assert.match(added, /remove_registered\(map, id\);/u);
  assert.match(added, /fn registry_removal_does_not_borrow_the_registered_value/u);
  assert.match(added, /assert!\(registry\.borrow\(\)\.is_empty\(\)\)/u);
  assert.doesNotMatch(added, /let map = map\.borrow_mut\(\);/u);

  assert.match(added, /\.try_inner\(\)/u);
  assert.match(added, /\.try_inner_mut\(\)/u);
  assert.equal(
    added.match(/WasiError::Exit\(Errno::Fault\.into\(\)\)/gu)?.length,
    2,
  );
  assert.doesNotMatch(added, /\.inner\(\)|ctx\.data_mut\(\)\.inner_mut\(\)/u);
  assert.match(buildScript, /instance handle inner borrow still retains the registry borrow/u);
});
