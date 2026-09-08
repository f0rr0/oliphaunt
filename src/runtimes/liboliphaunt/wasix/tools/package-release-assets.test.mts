import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageAotAssets, stageIcuAssets, stagePortableAssets } from './package-release-assets.mts';
import { canonicalWasixAotMetadata } from './wasix-aot-manifest.mts';

test('release staging preserves tool bytes, removes extension payloads, and rejects stale or unsafe inputs', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'wasix-release-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, bytes) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  };
  const portable = path.join(root, 'portable');
  write('portable/bin/pg_dump.wasix.wasm', 'dump');
  write('portable/bin/psql.wasix.wasm', 'sql');
  write('portable/extensions/pgvector.tar.zst', 'extension');
  write(
    'portable/manifest.json',
    JSON.stringify({
      'source-fingerprint': 'source',
      runtime: { 'postgres-version': '18.4' },
      extensions: ['pgvector'],
      'pg-dump': {},
      psql: {},
    }),
  );
  stagePortableAssets(portable, path.join(root, 'portable-out'), 'source');
  assert.equal(
    readFileSync(path.join(root, 'portable-out/bin/pg_dump.wasix.wasm'), 'utf8'),
    'dump',
  );
  assert(!readdirSync(path.join(root, 'portable-out')).includes('extensions'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'portable-out/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.extensions, []);
  assert(!('pg-dump' in manifest) && !('psql' in manifest));
  assert.throws(
    () => stagePortableAssets(portable, path.join(root, 'stale'), 'new-source'),
    /fingerprint/,
  );

  const canonical = canonicalWasixAotMetadata();
  const aot = {
    'format-version': 1,
    'source-lane': 'stable',
    'source-fingerprint': 'source',
    'target-triple': 'x86_64-unknown-linux-gnu',
    engine: canonical.engine,
    'wasmer-version': canonical.wasmerVersion,
    'wasmer-wasix-version': canonical.wasmerWasixVersion,
    artifacts: [
      { name: 'runtime:oliphaunt', path: 'nested/runtime.bin.zst' },
      { name: 'tool:pg_dump', path: 'pg_dump.bin.zst' },
      { name: 'tool:psql', path: 'psql.bin.zst' },
      { name: 'extension:vector:module', path: 'vector.bin.zst' },
    ],
  };
  const source = path.join(root, 'aot');
  const save = () => write('aot/manifest.json', JSON.stringify(aot));
  save();
  for (const artifact of aot.artifacts) write(`aot/${artifact.path}`, artifact.name);
  const stage = (name) =>
    stageAotAssets(source, path.join(root, name), aot['target-triple'], 'source');
  stage('aot-out');
  assert.equal(
    readFileSync(path.join(root, 'aot-out/nested/runtime.bin.zst'), 'utf8'),
    'runtime:oliphaunt',
  );
  assert(!readdirSync(path.join(root, 'aot-out')).includes('vector.bin.zst'));
  aot.artifacts[0].path = '../outside';
  save();
  assert.throws(() => stage('traversal'), /unsafe|relative|component/);
  aot.artifacts[0].path = 'linked/file';
  save();
  write('outside/file', 'outside');
  if (process.platform === 'win32') return;
  symlinkSync(path.join(root, 'outside'), path.join(source, 'linked'), 'dir');
  assert.throws(() => stage('linked'), /symbolic|symlink/);
});

test('ICU staging selects only data and rejects empty, ambiguous, and linked trees', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'wasix-icu-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, '76.1/icudt76l/coll'), { recursive: true });
  writeFileSync(path.join(source, '76.1/icudt76l/coll/en.res'), 'collation');
  writeFileSync(path.join(source, '76.1/LICENSE'), 'license');
  stageIcuAssets(source, path.join(root, 'out'));
  assert.deepEqual(readdirSync(path.join(root, 'out')), ['icudt76l']);
  assert.equal(readFileSync(path.join(root, 'out/icudt76l/coll/en.res'), 'utf8'), 'collation');
  mkdirSync(path.join(root, 'empty'));
  assert.throws(
    () => stageIcuAssets(path.join(root, 'empty'), path.join(root, 'empty-out')),
    /exactly one/,
  );
  mkdirSync(path.join(source, 'second'));
  writeFileSync(path.join(source, 'second/icudt.dat'), 'duplicate');
  assert.throws(() => stageIcuAssets(source, path.join(root, 'ambiguous')), /exactly one/);
  rmSync(path.join(source, 'second'), { recursive: true });
  if (process.platform === 'win32') return;
  symlinkSync(path.join(source, '76.1/LICENSE'), path.join(source, '76.1/icudt76l/coll/linked'));
  assert.throws(() => stageIcuAssets(source, path.join(root, 'linked')), /regular files/);
});
