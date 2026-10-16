import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  assertMissingHostRuntime,
  extractNativePayload,
  hostRuntimeEnvironment,
  runHostBinary,
} from './host-runtime-test-helpers.mts';

assert.equal(
  process.argv.length,
  6,
  'expected runtime payload, full C consumer, archive fixture and ICU profile consumer',
);
const [payload, sourceSmoke, sourceFixture, sourceProfile] = process.argv
  .slice(2)
  .map((file) => resolve(file));
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'host-runtime-'));
const runtime = join(root, 'runtime');
const consumer = join(root, 'consumer');
const bin = join(consumer, 'bin');
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';
const libraryName = windows
  ? 'oliphaunt.dll'
  : process.platform === 'darwin'
    ? 'liboliphaunt.dylib'
    : 'liboliphaunt.so';
const library = join(runtime, windows ? 'bin' : 'lib', libraryName);
const env = hostRuntimeEnvironment(runtime, root);
env.OLIPHAUNT_STREAM_QUEUE_MAX_BYTES = '4096';
const run = (binary: string, args: string[], overrides: NodeJS.ProcessEnv = {}) =>
  runHostBinary(binary, args, { ...env, ...overrides }, consumer);

function descriptor(database: string): void {
  writeFileSync(
    join(database, '.oliphaunt.json'),
    JSON.stringify({
      schema: 'oliphaunt-database-root-v1',
      engineFamily: 'native',
      pgdata: 'pgdata',
      postgresMajor: 18,
      physicalFormat: 'native-pg18-v1',
    }) + '\n',
  );
}

try {
  await extractNativePayload(payload!, runtime);
  mkdirSync(bin, { recursive: true });
  const smoke = join(bin, 'runtime_smoke' + suffix);
  const profile = join(bin, 'profile_smoke' + suffix);
  for (const [source, destination] of [
    [sourceSmoke!, smoke],
    [sourceProfile!, profile],
  ]) {
    copyFileSync(source, destination);
    if (!windows) chmodSync(destination, 0o755);
  }
  const fixture = join(consumer, 'physical-archive-native-v1.properties');
  copyFileSync(sourceFixture!, fixture);
  // The full C suite also reads this shared fixture relative to its cwd.
  const sharedFixture = 'src/test-fixtures/storage/physical-backup-wal-range-v1.properties';
  mkdirSync(dirname(join(consumer, sharedFixture)), { recursive: true });
  copyFileSync(resolve(sharedFixture), join(consumer, sharedFixture));

  const baseline = Bun.spawnSync([profile], { env, cwd: consumer, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(
    baseline.exitCode,
    2,
    `profile consumer did not load before candidate removal: ${baseline.stderr.toString()}`,
  );
  renameSync(library, library + '.disabled');
  try {
    const missing = Bun.spawnSync([profile], {
      env,
      cwd: consumer,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assertMissingHostRuntime(missing, libraryName);
  } finally {
    renameSync(library + '.disabled', library);
  }

  const initdb = join(runtime, 'bin', 'initdb' + suffix);
  const database = join(root, 'database');
  mkdirSync(database);
  run(
    initdb,
    [
      '-D',
      join(database, 'pgdata'),
      '-U',
      'postgres',
      '--auth=trust',
      '--no-sync',
      '--locale-provider=libc',
      '--locale=C',
      '--encoding=UTF8',
    ],
    {
      OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
      OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
    },
  );
  descriptor(database);
  for (let attempt = 0; attempt < 2; attempt++) {
    // Windows reopens the same database with mixed separators on the second pass.
    const pgdata = attempt === 0 ? join(database, 'pgdata') : `${database}/pgdata`;
    run(smoke, [pgdata, runtime, fixture]);
  }

  assert(
    readdirSync(join(runtime, 'share', 'icu')).some((name) => /^icudt\d+l\.dat$/u.test(name)),
    'runtime payload must retain the managed raw ICU data contract',
  );
  const icuDatabase = join(root, 'icu-database');
  mkdirSync(icuDatabase);
  run(
    initdb,
    [
      '-D',
      join(icuDatabase, 'pgdata'),
      '-U',
      'postgres',
      '--auth=trust',
      '--no-sync',
      '--locale-provider=icu',
      '--icu-locale=en-US',
      '--encoding=UTF8',
    ],
    {
      OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
      ICU_DATA: windows ? '/ambient/unverified-icu' : env.ICU_DATA,
    },
  );
  descriptor(icuDatabase);
  const sql =
    "WITH ordered AS (SELECT item FROM (VALUES ('z'), ('a'), (chr(228))) AS input(item) ORDER BY item) SELECT CASE WHEN datlocprovider = 'i' AND datlocale = 'en-US' AND (SELECT string_agg(item, ',') FROM ordered) = 'a,' || chr(228) || ',z' THEN 'BAZEL_ICU_OK' ELSE 'BAZEL_ICU_MISMATCH' END FROM pg_database WHERE datname = current_database()";
  for (let attempt = 0; attempt < 2; attempt++)
    run(profile, [join(icuDatabase, 'pgdata'), runtime, sql, 'BAZEL_ICU_OK'], {
      ICU_DATA: '/ambient/unverified-icu',
    });
  console.log(
    'Relocated candidate loader boundary, complete C runtime persistence and ICU profile reopen: PASS',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
