import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import {
  assertExecutedRustTests,
  nativeRustTestEnvironment,
  stageNativeRustExtensions,
} from './rust-runtime-test.mts';

test('runtime proof requires a successful harness with executed tests', () => {
  assertExecutedRustTests(
    'running 3 tests\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s',
  );
  for (const output of [
    'running 0 tests\ntest result: ok. 0 passed; 0 failed;',
    'test result: FAILED. 1 passed; 1 failed;',
    '',
  ])
    assert.throws(() => assertExecutedRustTests(output));
  assert.throws(() =>
    assertExecutedRustTests(
      'test result: ok. 1 passed; 0 failed;\ntest result: ok. 0 passed; 0 failed;',
    ),
  );
});

test('native carrier bindings cannot fall back to an installed host runtime', () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-rust-env-'));
  try {
    const native = path.join(root, 'native');
    const tools = path.join(root, 'tools');
    const broker = path.join(root, 'broker');
    const files = [
      path.join(native, 'lib/liboliphaunt.so'),
      path.join(native, 'runtime/bin/initdb'),
      path.join(native, 'runtime/bin/postgres'),
      path.join(tools, 'runtime/bin/psql'),
      path.join(tools, 'runtime/bin/pg_basebackup'),
      path.join(broker, 'bin/oliphaunt-broker'),
    ];
    for (const file of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'candidate');
    }
    const env = nativeRustTestEnvironment(native, tools, broker, root);
    assert.equal(env.LIBOLIPHAUNT_PATH, files[0]);
    assert.equal(env.OLIPHAUNT_BROKER, files.at(-1));
    assert.equal(env.OLIPHAUNT_INSTALL_DIR, path.join(native, 'runtime'));
    assert.equal(env.OLIPHAUNT_TOOLS_DIR, path.join(tools, 'runtime'));
    assert.equal(env.ICU_DATA, undefined);
    assert.equal(env.OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY, '1');
    assert(!env.LD_LIBRARY_PATH?.includes('/usr/lib'));
    assert.equal(readFileSync(files[0], 'utf8'), 'candidate');
    rmSync(files[0]);
    assert.throws(() => nativeRustTestEnvironment(native, tools, broker, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('original extension sidecars retain both ABI profiles and auxiliary data through File aliases', async () => {
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-extension-stage-'),
  );
  try {
    const files = {
      'extension.json': JSON.stringify({
        schema: 'oliphaunt-extension-member-payload-v1',
        sql_name: 'vector',
        family: 'native',
        configuration: 'linux-x64-gnu',
      }),
      'lib/modules/vector.so': 'embedded ABI',
      'lib/postgresql/vector.so': 'server ABI',
      'share/postgresql/extension/vector.control': "default_version = '0.8.2'",
      'share/postgresql/extension/vector--0.8.2.sql': 'CREATE EXTENSION fixture;',
      'share/postgresql/tsearch_data/fixture.rules': 'auxiliary data',
    };
    const archive = path.join(root, 'original.tar.gz');
    const bytes = gzipSync(await new Bun.Archive(files).bytes());
    writeFileSync(archive, bytes);
    const alias = path.join(root, 'declared-file-alias.tar.gz');
    symlinkSync(archive, alias);
    const resources = stageNativeRustExtensions(root, ['vector'], [alias]);
    assert(resources);
    assert.equal(resources, path.join(root, 'resources'));
    for (const [name, value] of Object.entries(files))
      assert.equal(readFileSync(path.join(resources, 'extension/vector', name), 'utf8'), value);
    assert.deepEqual(
      readFileSync(archive),
      bytes,
      'the original declared producer File is unchanged',
    );
    assert.equal(stageNativeRustExtensions(root, [], []), undefined);
    assert.throws(
      () => stageNativeRustExtensions(root, ['vector'], []),
      /original declared archive/u,
    );
    assert.throws(
      () => stageNativeRustExtensions(root, ['vector', 'vector'], [archive, archive]),
      /repeat/u,
    );
    assert.throws(
      () => stageNativeRustExtensions(root, ['../../outside'], [archive]),
      /canonical SQL name/u,
    );
    assert.throws(
      () => stageNativeRustExtensions(root, ['hstore'], [archive]),
      /configured member/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extension sidecars reject another target or family instead of substituting host resources', async () => {
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-extension-profile-'),
  );
  try {
    for (const override of [
      { configuration: 'linux-arm64-gnu' },
      { family: 'wasix' },
      { schema: 'unknown' },
    ]) {
      const archive = path.join(root, 'wrong-profile.tar.gz');
      writeFileSync(
        archive,
        gzipSync(
          await new Bun.Archive({
            'extension.json': JSON.stringify({
              schema: 'oliphaunt-extension-member-payload-v1',
              sql_name: 'vector',
              family: 'native',
              configuration: 'linux-x64-gnu',
              ...override,
            }),
          }).bytes(),
        ),
      );
      assert.throws(() => stageNativeRustExtensions(root, ['vector'], [archive]));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
