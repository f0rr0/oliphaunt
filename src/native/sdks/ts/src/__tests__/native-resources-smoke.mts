import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Oliphaunt } from '@oliphaunt/ts';

const require = createRequire(import.meta.url);
const root = process.env.OLIPHAUNT_RESOURCE_SMOKE_ROOT;
assert.ok(
  root,
  'OLIPHAUNT_RESOURCE_SMOKE_ROOT must be an isolated directory cleaned after host exit',
);
const profile = process.env.OLIPHAUNT_RESOURCE_PROFILE ?? 'standard';
assert.ok(profile === 'standard' || profile === 'icu' || profile === 'none');
const topology = process.env.OLIPHAUNT_RESOURCE_TOPOLOGY ?? 'direct';
assert.ok(topology === 'direct' || topology === 'broker');
const packageName = process.env.OLIPHAUNT_RESOURCE_SEED_PACKAGE;
assert.ok(
  profile === 'none' || packageName,
  'OLIPHAUNT_RESOURCE_SEED_PACKAGE must name the installed host seed',
);
const seed =
  profile === 'none'
    ? undefined
    : {
        directory: dirname(require.resolve(`${packageName}/pgdata/PG_VERSION`)),
        manifestPath: require.resolve(`${packageName}/manifest.json`),
      };
const icuData =
  profile === 'icu'
    ? {
        directory: dirname(require.resolve('@oliphaunt/icu/data')),
        manifestPath: require.resolve('@oliphaunt/icu/manifest'),
      }
    : undefined;
const config = {
  topology,
  libraryPath: process.env.LIBOLIPHAUNT_PATH,
  runtimeDirectory: process.env.OLIPHAUNT_INSTALL_DIR,
  brokerExecutable: process.env.OLIPHAUNT_BROKER,
  seed,
  icuData,
} as const;
if (seed) {
  const badManifest = join(root, 'corrupt-seed.json');
  const manifest = JSON.parse(await readFile(seed.manifestPath, 'utf8'));
  manifest.directory.treeSha256 = '0'.repeat(64);
  manifest.directory.path = seed.directory;
  await writeFile(badManifest, JSON.stringify(manifest));
  await assert.rejects(
    Oliphaunt.open({
      ...config,
      seed: { ...seed, manifestPath: badManifest },
      storage: { kind: 'directory', path: join(root, 'rejected') },
    }),
  );
  await assert.rejects(readFile(join(root, 'rejected', 'pgdata', 'PG_VERSION')), /ENOENT/);
}
const storage = { kind: 'directory', path: join(root, 'database') } as const;
await mkdir(root, { recursive: true });
let database = await Oliphaunt.open({ ...config, storage });
assert.deepEqual((await database.query('SELECT 42 AS answer')).rows, [{ answer: 42 }]);
if (icuData)
  assert.deepEqual((await database.query(`SELECT 'a' < 'b' COLLATE "und-x-icu" AS ordered`)).rows, [
    { ordered: true },
  ]);
await database.exec(
  'CREATE TABLE resource_probe(value integer); INSERT INTO resource_probe VALUES (73)',
);
await database.close();
database = await Oliphaunt.open({
  ...config,
  storage,
  seed: { directory: '/missing-seed', manifestPath: '/missing-seed-manifest' },
});
assert.deepEqual((await database.query('SELECT value FROM resource_probe')).rows, [{ value: 73 }]);
await database.close();
console.log(`native resource ${profile}/${topology} passed`);
