import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  requireNativeClusterSeedPath,
  requireNativeClusterSeedTarget,
} from '../native/cluster-seed.js';
import {
  copyNativeClusterSeed,
  initializeNativePgdata,
  nativeInitdbArgs,
  nativePostgresChildEnvironment,
} from '../native/initialize.js';
import { publishNativeDescriptor } from '../root-descriptor.js';

test('fresh native roots reject a non-bootstrap role before PGDATA mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-native-initialize-'));
  let populated = false;
  try {
    await assert.rejects(
      () =>
        initializeNativePgdata({
          root,
          pgdata: join(root, 'pgdata'),
          username: 'app_user',
          async populatePgdata() {
            populated = true;
          },
        }),
      /bootstrapped as postgres/,
    );
    assert.equal(populated, false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing native roots accept any existing connection role', async () => {
  const root = await completeRoot();
  let populated = false;
  try {
    await publishNativeDescriptor(root);
    await initializeNativePgdata({
      root,
      pgdata: join(root, 'pgdata'),
      username: 'app_user',
      async populatePgdata() {
        populated = true;
      },
    });
    assert.equal(populated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fresh native PGDATA is durably published before its root descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-native-initialize-'));
  try {
    await initializeNativePgdata({
      root,
      pgdata: join(root, 'pgdata'),
      username: 'postgres',
      populatePgdata: writeCompletePgdata,
    });
    assert.deepEqual((await readdir(root)).sort(), ['.oliphaunt.json', 'pgdata']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')(
  'native PGDATA publication rejects links before the staged tree is renamed',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'oliphaunt-native-initialize-'));
    try {
      await assert.rejects(
        () =>
          initializeNativePgdata({
            root,
            pgdata: join(root, 'pgdata'),
            username: 'postgres',
            async populatePgdata(pgdata) {
              await writeCompletePgdata(pgdata);
              await symlink('PG_VERSION', join(pgdata, 'linked-version'));
            },
          }),
        /symbolic link/,
      );
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('descriptor failure rolls back newly published PGDATA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-native-initialize-'));
  try {
    await assert.rejects(
      () =>
        initializeNativePgdata(
          {
            root,
            pgdata: join(root, 'pgdata'),
            username: 'postgres',
            populatePgdata: writeCompletePgdata,
          },
          async () => {
            throw new Error('descriptor write failed');
          },
        ),
      /descriptor write failed/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a descriptor renamed before a reported sync failure keeps the valid root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-native-initialize-'));
  try {
    await assert.rejects(
      () =>
        initializeNativePgdata(
          {
            root,
            pgdata: join(root, 'pgdata'),
            username: 'postgres',
            populatePgdata: writeCompletePgdata,
          },
          async (databaseRoot) => {
            await publishNativeDescriptor(databaseRoot);
            throw new Error('directory sync result was uncertain');
          },
        ),
      /directory sync result was uncertain/,
    );
    assert.deepEqual((await readdir(root)).sort(), ['.oliphaunt.json', 'pgdata']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native initdb always creates the fixed postgres bootstrap role', () => {
  const args = nativeInitdbArgs('/database/pgdata');
  assert.deepEqual(args.slice(0, 4), ['-D', '/database/pgdata', '-U', 'postgres']);
});

test('native PostgreSQL child environments isolate internal seed controls', () => {
  const ambient = {
    PATH: '/bin',
    ICU_DATA: '/ambient/icu',
    OLIPHAUNT_INTERNAL_ICU_READY: '1',
    OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
    OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
  };
  assert.deepEqual(nativePostgresChildEnvironment(ambient), { PATH: '/bin' });
  assert.deepEqual(nativePostgresChildEnvironment(ambient, { initdbCatalogProfile: 'standard' }), {
    PATH: '/bin',
    OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
  });
  assert.deepEqual(
    nativePostgresChildEnvironment(ambient, {
      icuDataDirectory: '/verified/icu',
      initdbCatalogProfile: 'icu',
    }),
    {
      PATH: '/bin',
      ICU_DATA: '/verified/icu',
      OLIPHAUNT_INTERNAL_ICU_READY: '1',
    },
  );
  assert.throws(
    () => nativePostgresChildEnvironment(ambient, { initdbCatalogProfile: 'icu' }),
    /requires verified ICU data/,
  );
});

test('native runtime carrier metadata is host-bound and uses fixed seed siblings', () => {
  assert.equal(
    requireNativeClusterSeedTarget('linux-x64-gnu', 'linux-x64-gnu', 'fixture'),
    'linux-x64-gnu',
  );
  assert.equal(
    requireNativeClusterSeedPath('cluster-seed', 'cluster-seed', 'fixture'),
    'cluster-seed',
  );
  assert.throws(
    () => requireNativeClusterSeedTarget('other-target', 'linux-x64-gnu', 'fixture'),
    /clusterSeedTarget/,
  );
  assert.throws(
    () => requireNativeClusterSeedPath('nested/cluster-seed', 'cluster-seed', 'fixture'),
    /must be cluster-seed/,
  );
});

async function completeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-native-existing-'));
  await writeCompletePgdata(join(root, 'pgdata'));
  return root;
}

async function writeCompletePgdata(pgdata: string): Promise<void> {
  await mkdir(join(pgdata, 'global'), { recursive: true });
  await mkdir(join(pgdata, 'pg_wal'));
  await writeFile(join(pgdata, 'PG_VERSION'), '18\n');
  await writeFile(join(pgdata, 'global', 'pg_control'), new Uint8Array([1]));
}

test('packaged seed restores empty directories and private permissions without modifying the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-seed-copy-'));
  const seed = join(root, 'seed');
  const staging = join(root, 'pgdata');
  try {
    await mkdir(join(seed, 'files'), { recursive: true });
    await chmod(join(seed, 'files'), 0o755);
    const inventory = join(seed, 'directories-v1.txt');
    await writeFile(inventory, 'pg_notify\npg_wal/archive_status\n');
    await copyNativeClusterSeed(seed, staging);
    assert.deepEqual(await readdir(join(staging, 'pg_notify')), []);
    assert.ok((await stat(join(staging, 'pg_wal', 'archive_status'))).isDirectory());
    assert.deepEqual(await readdir(join(seed, 'files')), []);
    if (process.platform !== 'win32') assert.equal((await stat(staging)).mode & 0o777, 0o700);
    for (const invalid of ['../escape', '/escape', 'pg_wal/../../escape', 'pg_wal\\escape']) {
      await writeFile(inventory, `${invalid}\n`);
      await rm(staging, { recursive: true });
      await assert.rejects(copyNativeClusterSeed(seed, staging), /unsafe seed directory/u);
    }
    if (process.platform !== 'win32') {
      await symlink(root, join(seed, 'files', 'link'));
      await rm(staging, { recursive: true });
      await assert.rejects(copyNativeClusterSeed(seed, staging), /regular file or directory/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
