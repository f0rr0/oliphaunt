import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashRegular, verify } from '../../../src/wasix/postmaster/lib/verify-sealed-carrier.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import { nativeWasmerReceipt, runtimeAbiFacts } from './native-receipts.mts';

const arguments_ = Bun.argv.slice(2);
const libraryNameAt = arguments_.indexOf('--libpq-name');
const libraryName = libraryNameAt < 0 ? 'libpq.so.5' : arguments_.splice(libraryNameAt, 2)[1];
assert(
  ['libpq.so.5', 'libpq.5.dylib'].includes(libraryName),
  'Unsupported native libpq installed name',
);
const archiveInput = arguments_[0] === '--archive';
if (archiveInput) arguments_.shift();
const [carrierArg, psqlArg, libraryOrWork, archiveWork] = arguments_;
assert(
  carrierArg &&
    psqlArg &&
    (archiveInput ? libraryOrWork && arguments_.length <= 4 : arguments_.length <= 3),
  'usage: runtime-test.mts CARRIER PSQL [WORK] | --archive CARRIER PSQL LIBPQ [WORK]',
);
const psqlSource = realpathSync(resolve(psqlArg));
const workArg = archiveInput ? archiveWork : libraryOrWork;
const work = workArg
  ? resolve(workArg)
  : process.env.TEST_UNDECLARED_OUTPUTS_DIR
    ? join(process.env.TEST_UNDECLARED_OUTPUTS_DIR, 'postmaster-runtime')
    : mkdtempSync(join(tmpdir(), 'postmaster-native-runtime-'));
mkdirSync(work, { recursive: true });
let psql = psqlSource;
const libpq = archiveInput && libraryOrWork ? realpathSync(resolve(libraryOrWork)) : undefined;
if (libpq) {
  psql = join(work, 'client/bin/psql');
  const library = join(work, 'client/lib', libraryName);
  // Match the maintained native psql loader path and libpq installed identity.
  for (const [source, destination] of [
    [psqlSource, psql],
    [libpq, library],
  ]) {
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, readFileSync(source), { flag: 'wx' });
    chmodSync(destination, lstatSync(source).mode & 0o555);
    assert.deepEqual(hashRegular(destination), hashRegular(source));
  }
}
const carrier = archiveInput ? join(work, 'carrier') : resolve(carrierArg);
const archive = archiveInput ? realpathSync(resolve(carrierArg)) : undefined;
if (archive) {
  extractPortableArchiveTree(archive, carrier, '', { format: 'tar.gz' });
  // The portable archive writer normalizes writable modes; seal the installed carrier again.
  const readonly = (file: string) => {
    const stat = lstatSync(file);
    assert(stat.isDirectory() || stat.isFile(), 'Installed carrier contains a special entry');
    if (stat.isDirectory()) for (const name of readdirSync(file)) readonly(join(file, name));
    chmodSync(file, stat.mode & 0o555);
  };
  readonly(carrier);
}
const wasmer = JSON.parse(readFileSync(join(carrier, 'wasmer-build.receipt'), 'utf8'));
nativeWasmerReceipt(wasmer);
const facts = runtimeAbiFacts(wasmer.runtime_abi);
if (libpq)
  assert.equal(
    libraryName,
    facts.hostAbi === 'darwin' ? 'libpq.5.dylib' : 'libpq.so.5',
    'Native client library differs from actual carrier host',
  );
const manifest = JSON.parse(readFileSync(join(carrier, 'manifest.json'), 'utf8'));
verify(
  carrier,
  hashRegular(join(carrier, 'wasmer-build.receipt')).sha256,
  manifest['postgres-version'],
  facts.wasmerVersion,
  facts.wasixVersion,
  wasmer.runtime_abi.artifact_abi_version,
  carrier,
);
const data = join(work, 'pgdata'),
  shm = join(work, 'dev-shm');
mkdirSync(data);
mkdirSync(shm);
const executor = join(carrier, 'bin/wasmer-headless');
const common = [
  'run',
  '--quiet',
  '--disable-cache',
  '--sealed-module-manifest',
  join(carrier, 'manifest.json'),
  '--stack-size',
  '33554432',
  '--enable-exceptions',
  '--enable-threads',
  '--net',
  '--volume',
  `${carrier}:${carrier}`,
  '--volume',
  `${carrier}/share:/share`,
  '--volume',
  `${carrier}/lib:/lib`,
  '--volume',
  `${data}:/pgdata`,
  '--volume',
  `${shm}:/dev/shm`,
];
const commands: any[] = [];
const launch = (name: string, module: string, args: string[]) => {
  const argv = [executor, ...common, join(carrier, `bin/${module}`), '--', ...args];
  const child = Bun.spawn(argv, {
    env: {
      LC_ALL: 'C',
      OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE: join(work, `${name}.loader.jsonl`),
    },
    stdin: 'ignore',
    stdout: Bun.file(join(work, `${name}.stdout`)),
    stderr: Bun.file(join(work, `${name}.stderr`)),
  });
  commands.push({ name, argv, pid: child.pid });
  return child;
};
async function exited(child: ReturnType<typeof Bun.spawn>, name: string, seconds = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${name} timed out; logs: ${work}`));
        }, seconds * 1000);
      }),
    ]);
    assert.equal(
      code,
      0,
      `${name} failed; logs: ${work}\n${readFileSync(join(work, `${name}.stderr`), 'utf8')}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
await exited(
  launch('initdb', 'initdb', [
    '-D',
    '/pgdata',
    '-A',
    'trust',
    '--username',
    'postgres',
    '--no-locale',
    '--encoding=UTF8',
    '--no-instructions',
  ]),
  'initdb',
);
assert.equal(readFileSync(join(data, 'PG_VERSION'), 'utf8'), '18\n');
const listener = createServer();
await new Promise<void>((resolve, reject) =>
  listener.once('error', reject).listen(0, '127.0.0.1', resolve),
);
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const sql = async (query: string) => {
  const child = Bun.spawn(
    [
      psql,
      '-X',
      '-A',
      '-t',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-c',
      query,
    ],
    { env: { LC_ALL: 'C', PGCONNECT_TIMEOUT: '1' }, stdout: 'pipe', stderr: 'pipe' },
  );
  const output = new Response(child.stdout).text(),
    error = new Response(child.stderr).text();
  assert.equal(await child.exited, 0, `SQL failed: ${await error}`);
  return (await output).trim();
};
const assertDurability = async () => {
  assert.equal(
    await sql(`SELECT
      current_setting('fsync') = 'on' AND
      current_setting('synchronous_commit') = 'on' AND
      current_setting('full_page_writes') = 'on' AND
      current_setting('checkpoint_timeout')::interval = interval '1 hour'`),
    't',
    'Recovery qualification requires durable commits and a controlled checkpoint interval',
  );
};
const contents = () => sql('SELECT value FROM native_carrier_probe ORDER BY value');
const start = async (name: string) => {
  const child = launch(name, 'postgres', [
    '-D',
    '/pgdata',
    '-h',
    '127.0.0.1',
    '-p',
    String(port),
    '-c',
    'unix_socket_directories=',
    ...[
      'fsync=on',
      'synchronous_commit=on',
      'full_page_writes=on',
      'checkpoint_timeout=1h',
    ].flatMap((setting) => ['-c', setting]),
  ]);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    assert(child.exitCode === null, `${name} exited early; logs: ${work}`);
    try {
      assert.equal(await sql('SELECT 42'), '42');
      return child;
    } catch {
      await Bun.sleep(200);
    }
  }
  child.kill('SIGKILL');
  await child.exited;
  assert.fail(`${name} startup timed out; logs: ${work}`);
};
let active: ReturnType<typeof Bun.spawn> | undefined;
try {
  active = await start('start');
  await assertDurability();
  await sql(`CREATE TABLE native_carrier_probe(value integer);
    INSERT INTO native_carrier_probe VALUES (42);
    CREATE TABLE native_concurrent_probe(
      client integer NOT NULL, iteration integer NOT NULL, backend_pid integer NOT NULL,
      started_at timestamptz NOT NULL, finished_at timestamptz, value integer NOT NULL,
      PRIMARY KEY(client, iteration)
    )`);
  const clients = 4,
    perClientRows = 32;
  // Commit arrivals before waiting so every backend can observe the rendezvous.
  const pids = await Promise.all(
    Array.from({ length: clients }, (_, index) => {
      const client = index + 1;
      return sql(`SET statement_timeout = '30s';
        BEGIN;
        INSERT INTO native_concurrent_probe
        SELECT ${client}, iteration, pg_backend_pid(), clock_timestamp(), NULL,
          ${client} * 100 + iteration
        FROM generate_series(1, ${perClientRows}) AS iteration;
        COMMIT;
        DO $$ BEGIN
          WHILE (SELECT count(DISTINCT client) FROM native_concurrent_probe) <> ${clients} LOOP
            PERFORM pg_sleep(0.01);
          END LOOP;
        END $$ LANGUAGE plpgsql;
        UPDATE native_concurrent_probe SET finished_at = clock_timestamp(), value = value + 1
        WHERE client = ${client};
        SELECT pg_backend_pid()`);
    }),
  );
  assert.equal(
    new Set(pids).size,
    clients,
    'Concurrent connections must have independent backend PIDs',
  );
  const concurrent = (
    await sql(`SELECT count(*), count(DISTINCT client), count(DISTINCT backend_pid),
      count(finished_at), bool_and(value = client * 100 + iteration + 1),
      max(started_at) <= min(finished_at)
      FROM native_concurrent_probe`)
  ).split('|');
  const concurrentRows = String(clients * perClientRows);
  assert.deepEqual(
    concurrent,
    [concurrentRows, String(clients), String(clients), concurrentRows, 't', 't'],
    'Concurrent indexed writers must all overlap, acknowledge their inserts and finish their updates',
  );
  assert.equal(
    await sql("SELECT to_tsvector('english', 'running') @@ to_tsquery('english', 'run')"),
    't',
    'Packaged Snowball stemming must execute',
  );
  assert.equal(await sql('SELECT sum(value) FROM native_carrier_probe'), '42');
  active.kill('SIGTERM');
  await exited(active, 'start');
  active = undefined;
  active = await start('restart');
  await assertDurability();
  assert.equal(await sql('SELECT sum(value) FROM native_carrier_probe'), '42');
  // Checkpoint a multi-page indexed baseline before changing heap and index entries.
  await sql(`CREATE UNIQUE INDEX native_carrier_probe_value ON native_carrier_probe(value);
    INSERT INTO native_carrier_probe SELECT generate_series(1000, 2023)`);
  assert.equal(
    await sql(
      `SELECT pg_relation_size('native_carrier_probe') > current_setting('block_size')::int`,
    ),
    't',
    'Recovery qualification must cover more than one heap page',
  );
  await sql('CHECKPOINT');
  const [baselineCheckpoint, baselineFlush] = (
    await sql('SELECT (pg_control_checkpoint()).checkpoint_lsn, pg_current_wal_flush_lsn()')
  ).split('|');
  assert.match(baselineCheckpoint, /^[0-9A-F]+\/[0-9A-F]+$/);
  assert.match(baselineFlush, /^[0-9A-F]+\/[0-9A-F]+$/);
  await sql(`UPDATE native_carrier_probe SET value = value + 10000
    WHERE value BETWEEN 1000 AND 2023 AND value % 2 = 0`);
  // sql returns after COMMIT; retain this batch's position before later background WAL.
  const acknowledgedInsert = await sql(`WITH inserted AS (
      INSERT INTO native_carrier_probe SELECT generate_series(3000, 3511) RETURNING value
    ) SELECT pg_current_wal_insert_lsn() FROM inserted HAVING count(*) = 512`);
  assert.match(acknowledgedInsert, /^[0-9A-F]+\/[0-9A-F]+$/);
  const expectedValues = [
    42,
    ...Array.from({ length: 1024 }, (_, index) => {
      const value = 1000 + index;
      return value % 2 === 0 ? value + 10000 : value;
    }),
    ...Array.from({ length: 512 }, (_, index) => 3000 + index),
  ].sort((left, right) => left - right);
  const beforeCrash = await contents();
  assert.equal(beforeCrash, expectedValues.join('\n'));
  const [preCrashCheckpoint, preCrashFlush, flushCoversInserts, flushAdvanced] = (
    await sql(`SELECT
      (pg_control_checkpoint()).checkpoint_lsn,
      pg_current_wal_flush_lsn(),
      '${acknowledgedInsert}'::pg_lsn <= pg_current_wal_flush_lsn(),
      pg_current_wal_flush_lsn() > '${baselineFlush}'::pg_lsn`)
  ).split('|');
  assert.equal(preCrashCheckpoint, baselineCheckpoint, 'Checkpoint advanced after the baseline');
  assert.equal(flushCoversInserts, 't', 'Acknowledged inserts must be flushed to WAL');
  assert.equal(flushAdvanced, 't', 'Post-checkpoint commits must advance flushed WAL');
  // Match the canonical immediate-recovery gate: the host signal must reach
  // PostgreSQL, clean up shared objects, and leave WAL recovery for the restart.
  // Hard host SIGKILL remains the canonical fail-closed shared-object liveness
  // limitation; this test never deletes shared objects to admit a restart.
  active.kill('SIGQUIT');
  await exited(active, 'restart');
  assert.match(
    readFileSync(join(work, 'restart.stderr'), 'utf8'),
    /received immediate shutdown request/,
  );
  assert.deepEqual(readdirSync(shm), [], 'Shared objects survived immediate guest shutdown');
  active = undefined;
  active = await start('recovery');
  await assertDurability();
  assert.equal(await contents(), beforeCrash, 'WAL recovery changed acknowledged rows');
  const recoveryLog = readFileSync(join(work, 'recovery.stderr'), 'utf8');
  assert.match(recoveryLog, /database system was interrupted/);
  assert.match(recoveryLog, /redo starts at/);
  active.kill('SIGTERM');
  await exited(active, 'recovery');
  assert.match(
    readFileSync(join(work, 'recovery.stderr'), 'utf8'),
    /received smart shutdown request/,
  );
  active = undefined;
  active = await start('clean-reopen');
  await assertDurability();
  assert.equal(await contents(), beforeCrash, 'Clean reopen changed recovered rows');
  const cleanLog = readFileSync(join(work, 'clean-reopen.stderr'), 'utf8');
  assert.match(cleanLog, /database system was shut down at/);
  assert.doesNotMatch(cleanLog, /automatic recovery in progress/);
  active.kill('SIGTERM');
  await exited(active, 'clean-reopen');
  active = undefined;
  writeFileSync(
    join(work, 'runtime-result.json'),
    `${JSON.stringify({ ...(archive ? { archive: hashRegular(archive) } : {}), ...(libpq ? { libpq: hashRegular(libpq) } : {}), carrier_manifest: hashRegular(join(carrier, 'manifest.json')), executor: hashRegular(executor), psql: hashRegular(psql), commands, sql: { answer: 42, concurrent_backend_pids: pids, reopen: 42, recovered: expectedValues.reduce((sum, value) => sum + value, 0) }, immediate_shutdown: { signal: 'SIGQUIT', exit_code: 0, shared_objects_empty: true, redo: true, baseline_checkpoint_lsn: baselineCheckpoint, baseline_flush_lsn: baselineFlush, acknowledged_insert_lsn: acknowledgedInsert, pre_crash_flush_lsn: preCrashFlush, exact_row_count: expectedValues.length, clean_reopen: true } }, null, 2)}\n`,
  );
  console.log(
    `Native postmaster initdb/start/concurrent SQL/reopen/immediate WAL recovery/clean reopen PASS: ${work}`,
  );
} finally {
  if (active && active.exitCode === null) {
    active.kill('SIGKILL');
    await active.exited;
  }
}
