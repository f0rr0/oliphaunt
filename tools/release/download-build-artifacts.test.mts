import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zipArchive } from '../packaging/testdata/zip-fixture.mts';

const [mode, root, kind] = process.argv.slice(2);
const archive = path.join(root, 'artifact.zip');
if (mode === 'prepare') {
  mkdirSync(root, { recursive: true });
  const row =
    kind === 'traversal'
      ? { name: '../../escaped.txt', data: 'bad' }
      : kind === 'corrupt'
        ? { name: 'payload.txt', data: 'bad', crc: 1 }
        : { name: 'payload.txt', data: 'correct' };
  writeFileSync(archive, zipArchive([row]));
  const bytes = readFileSync(archive);
  const artifact = {
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    id: 101,
    name: 'exact-artifact',
    size: bytes.length,
  };
  for (const [name, value] of Object.entries({
    approved: [artifact],
    wrong: [{ ...artifact, id: 999 }],
    subset: [artifact, { ...artifact, id: 102, name: 'exact-artifact-near-match' }],
    duplicate: [artifact, artifact],
  }))
    writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value));
} else if (mode === 'assert') {
  assert.deepEqual(
    readdirSync(root).filter(
      (name) => name.startsWith('.durable.') || name.startsWith('oliphaunt-artifact-download.'),
    ),
    [],
  );
  assert.equal(existsSync(path.join(root, 'durable/partial.txt')), false);
  if (kind === 'snapshot' || kind === 'pagination') {
    const endpoints = readFileSync(path.join(root, 'gh.log'), 'utf8')
      .trim()
      .split(/\r?\n/u)
      .map(JSON.parse);
    if (kind === 'pagination')
      assert.equal(
        endpoints.filter((endpoint) => endpoint.includes('/actions/workflows/9/runs?')).length,
        2,
      );
    else {
      for (const pattern of [
        /actions\/runs\/77$/u,
        /actions\/workflows\/9$/u,
        /actions\/runs\/77\/jobs/u,
        /actions\/runs\/77\/artifacts/u,
      ])
        assert.equal(endpoints.filter((endpoint) => pattern.test(endpoint)).length, 1);
      assert.equal(
        endpoints.filter((endpoint) => /actions\/artifacts\/101\/zip$/u.test(endpoint)).length,
        2,
      );
    }
  }
} else throw Error('expected prepare or assert');
