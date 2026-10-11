import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { materializeArchive, privateWork, readSpecification, run } from './shared.mts';
import { extractWasixRuntime } from './wasix_inputs.mts';

const specification = readSpecification();
assert.equal(specification.target, 'portable');
const work = privateWork(path.resolve(specification.output));
try {
  const runtime = extractWasixRuntime(specification.runtime, work);
  let icuData: string | undefined;
  if (specification.icu) {
    const icuRoot = path.join(work, 'icu');
    extractPortableArchiveTree(
      materializeArchive(specification.icu, path.join(work, 'inputs')),
      icuRoot,
    );
    icuData = path.join(icuRoot, 'share/icu');
    validateNativeIcuDataManifest(readFileSync(path.join(icuRoot, 'manifest.properties')), icuData);
  }
  assert.equal(specification.profile === 'icu', Boolean(icuData));
  const prepared = path.join(work, 'prepared');
  run(
    path.resolve(specification.runner),
    [runtime, prepared, specification.profile, ...(icuData ? [icuData] : [])],
    { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', RAYON_NUM_THREADS: '2' },
    work,
  );
  // The genuine WASIX initdb constructor verifies both profile and reopen.
  // Freeze its unique PGDATA intact; do not normalize clock/PID/random fields.
  writeFileSync(specification.output, await createDeterministicTar(path.join(prepared, 'pgdata')));
} finally {
  rmSync(work, { recursive: true, force: true });
}
