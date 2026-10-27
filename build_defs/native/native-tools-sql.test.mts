import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  extractNativePayload,
  hostRuntimeEnvironment,
  runHostBinary,
} from './host-runtime-test-helpers.mts';

const [runtimeArchive, toolsArchive] = process.argv.slice(2).map((file) => resolve(file));
assert(runtimeArchive && toolsArchive, 'expected actual runtime and tools archives');
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-tools-'));
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';
// Unix socket names have a small OS limit; Bazel test temporary paths can exceed it.
const socket = windows ? undefined : mkdtempSync('/tmp/oliphaunt-pg-socket-');
const runtime = join(root, 'runtime');
const tools = join(root, 'tools');
const database = join(root, 'database');
const env: NodeJS.ProcessEnv = {
  ...hostRuntimeEnvironment(runtime, root),
  PGHOST: windows ? '127.0.0.1' : socket,
  PGPORT: '5432',
  PGUSER: 'oliphaunt_native_test',
  PGDATABASE: 'postgres',
};

function run(binary: string, args: string[], output: 'pipe' | 'inherit' = 'pipe'): string {
  console.log(`Native tools: ${basename(binary)} begin`);
  const result = runHostBinary(binary, args, env, root, output);
  console.log(`Native tools: ${basename(binary)} done`);
  return result;
}

async function freeTcpPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return String(address.port);
}

let running = false;
try {
  console.log('Native tools: runtime extraction begin');
  await extractNativePayload(runtimeArchive, runtime);
  console.log('Native tools: runtime extraction done; tools extraction begin');
  await extractNativePayload(toolsArchive, tools);
  console.log('Native tools: tools extraction done');
  mkdirSync(database);
  const initdb = join(runtime, 'bin', 'initdb' + suffix);
  const control = join(runtime, 'bin', 'pg_ctl' + suffix);
  const psql = join(tools, 'bin', 'psql' + suffix);
  const dump = join(tools, 'bin', 'pg_dump' + suffix);
  const backup = join(tools, 'bin', 'pg_basebackup' + suffix);
  run(initdb, [
    '-D',
    database,
    '-U',
    env.PGUSER!,
    '--locale=C',
    '--encoding=UTF8',
    '--auth=trust',
    '--no-sync',
  ]);
  if (windows) env.PGPORT = await freeTcpPort();
  const serverOptions = windows
    ? `-h 127.0.0.1 -p ${env.PGPORT}`
    : `-k ${socket} -h '' -p ${env.PGPORT}`;
  running = true;
  // Windows pg_ctl's CMD child keeps inherited handles until the server exits.
  run(
    control,
    ['-D', database, '-l', join(root, 'postgres.log'), '-o', serverOptions, '-w', 'start'],
    'inherit',
  );
  const sql = (statement: string) =>
    run(psql, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', statement]).trim();
  assert.equal(sql('SELECT 42'), '42');
  sql(
    "CREATE TABLE native_tools_probe(id integer PRIMARY KEY, payload text); INSERT INTO native_tools_probe VALUES (7, 'round trip')",
  );
  const logical = run(dump, ['--no-owner', '--no-privileges']);
  assert.match(logical, /COPY public\.native_tools_probe/u);
  assert.match(logical, /7\tround trip/u);
  sql('DROP TABLE native_tools_probe');
  console.log('Native tools: psql restore begin');
  const restore = Bun.spawnSync([psql, '-X', '-v', 'ON_ERROR_STOP=1'], {
    env,
    cwd: root,
    stdin: Buffer.from(logical),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(restore.exitCode, 0, restore.stderr.toString());
  console.log('Native tools: psql restore done');
  assert.equal(sql('SELECT payload FROM native_tools_probe WHERE id=7'), 'round trip');
  const physical = join(root, 'physical-backup');
  run(backup, [
    '-D',
    physical,
    '--format=plain',
    '--wal-method=stream',
    '--checkpoint=fast',
    '--no-sync',
  ]);
  assert.match(
    readFileSync(join(physical, 'backup_manifest'), 'utf8'),
    /PostgreSQL-Backup-Manifest-Version/u,
  );
  run(control, ['-D', database, '-m', 'fast', '-w', 'stop']);
  running = false;
  running = true;
  run(
    control,
    ['-D', physical, '-l', join(root, 'backup-postgres.log'), '-o', serverOptions, '-w', 'start'],
    'inherit',
  );
  assert.equal(sql('SELECT payload FROM native_tools_probe WHERE id=7'), 'round trip');
  run(control, ['-D', physical, '-m', 'fast', '-w', 'stop']);
  running = false;
  console.log(
    'Native tools: extracted pg_ctl lifecycle, psql, logical dump/restore, streaming backup and recovered SQL passed.',
  );
} finally {
  if (running) {
    for (const directory of [database, join(root, 'physical-backup')])
      Bun.spawnSync(
        [join(runtime, 'bin', 'pg_ctl' + suffix), '-D', directory, '-m', 'immediate', '-w', 'stop'],
        { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
      );
  }
  if (socket) rmSync(socket, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
