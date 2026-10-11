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
  const library = join(work, 'client/lib/libpq.so.5');
  // Match the actual native psql $ORIGIN/../lib and libpq.so.5 SONAME contract.
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
  await sql(
    'CREATE TABLE native_carrier_probe(value integer); INSERT INTO native_carrier_probe VALUES (42)',
  );
  const pids = await Promise.all(
    Array.from({ length: 4 }, () =>
      sql('SELECT pg_backend_pid() FROM (SELECT pg_sleep(0.2)) AS delay'),
    ),
  );
  assert.equal(new Set(pids).size, 4, 'Concurrent connections must have independent backend PIDs');
  assert.equal(await sql('SELECT sum(value) FROM native_carrier_probe'), '42');
  active.kill('SIGTERM');
  await exited(active, 'start');
  active = undefined;
  active = await start('restart');
  assert.equal(await sql('SELECT sum(value) FROM native_carrier_probe'), '42');
  await sql('INSERT INTO native_carrier_probe VALUES (8)');
  assert.equal(await sql('SELECT sum(value) FROM native_carrier_probe'), '50');
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
  assert.equal(await sql('SELECT sum(value) FROM native_carrier_probe'), '50');
  const recoveryLog = readFileSync(join(work, 'recovery.stderr'), 'utf8');
  assert.match(recoveryLog, /database system was interrupted/);
  assert.match(recoveryLog, /redo starts at/);
  active.kill('SIGTERM');
  await exited(active, 'recovery');
  active = undefined;
  writeFileSync(
    join(work, 'runtime-result.json'),
    `${JSON.stringify({ ...(archive ? { archive: hashRegular(archive) } : {}), ...(libpq ? { libpq: hashRegular(libpq) } : {}), carrier_manifest: hashRegular(join(carrier, 'manifest.json')), executor: hashRegular(executor), psql: hashRegular(psql), commands, sql: { answer: 42, concurrent_backend_pids: pids, reopen: 42, recovered: 50 }, immediate_shutdown: { signal: 'SIGQUIT', exit_code: 0, shared_objects_empty: true, redo: true } }, null, 2)}\n`,
  );
  console.log(
    `Native postmaster initdb/start/concurrent SQL/reopen/immediate WAL recovery PASS: ${work}`,
  );
} finally {
  if (active && active.exitCode === null) {
    active.kill('SIGKILL');
    await active.exited;
  }
}
