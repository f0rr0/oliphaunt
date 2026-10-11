import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashRegular, verify } from '../../../src/wasix/postmaster/lib/verify-sealed-carrier.mts';
import { nativeWasmerReceipt, runtimeAbiFacts } from './native-receipts.mts';

const [carrierArg, psqlArg, workArg] = Bun.argv.slice(2);
assert(carrierArg && psqlArg, 'usage: runtime-test.mts CARRIER PSQL [WORK]');
const carrier = resolve(carrierArg),
  psql = resolve(psqlArg);
const work = workArg ? resolve(workArg) : mkdtempSync(join(tmpdir(), 'postmaster-native-runtime-'));
mkdirSync(work, { recursive: true });
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
  active.kill('SIGTERM');
  await exited(active, 'restart');
  active = undefined;
  writeFileSync(
    join(work, 'runtime-result.json'),
    `${JSON.stringify({ carrier_manifest: hashRegular(join(carrier, 'manifest.json')), executor: hashRegular(executor), psql: hashRegular(psql), commands, sql: { answer: 42, concurrent_backend_pids: pids, reopen: 42 } }, null, 2)}\n`,
  );
  console.log(`Native postmaster initdb/start/concurrent SQL/reopen PASS: ${work}`);
} finally {
  if (active && active.exitCode === null) {
    active.kill('SIGKILL');
    await active.exited;
  }
}
