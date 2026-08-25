import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  requireNativeClusterSeedPath,
  requireNativeClusterSeedTarget,
} from '../native/cluster-seed.js';
import {
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
