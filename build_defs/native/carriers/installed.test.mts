/** Qualify relocation of the finished public GitHub and npm carriers. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import {
  assertMissingHostRuntime,
  hostRuntimeEnvironment,
  runHostBinary,
} from '../host-runtime-test-helpers.mts';
import { expectedLogicalValue, VERIFY_SQL } from './tools-consumer.mts';

const [
  runtimeArchive,
  runtimeNpmArchive,
  toolsArchive,
  facadeArchive,
  leafArchive,
  profileConsumer,
  npmConsumer,
  fixture,
  node,
] = process.argv.slice(2).map((file) => path.resolve(file));
assert(
  runtimeArchive &&
    runtimeNpmArchive &&
    toolsArchive &&
    facadeArchive &&
    leafArchive &&
    profileConsumer &&
    npmConsumer &&
    fixture &&
    node,
);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'installed-native-'));
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';
const native = path.join(root, 'installed-runtime');
const runtime = path.join(native, 'runtime');
const tools = path.join(root, 'installed-tools/runtime');
const consumer = path.join(root, `consumer${suffix}`);
const database = path.join(root, 'server-database');
const restored = path.join(root, 'server-backup');
// Socket filenames have a small independent OS limit, even when TEST_TMPDIR is long.
const socket = windows ? undefined : mkdtempSync('/tmp/oliphaunt-carrier-socket-');
let running: string | undefined;
const library = windows
  ? 'bin/oliphaunt.dll'
  : process.platform === 'darwin'
    ? 'lib/liboliphaunt.dylib'
    : 'lib/liboliphaunt.so';
function runtimeEnvironment(installed: string): NodeJS.ProcessEnv {
  const installedRuntime = path.join(installed, 'runtime');
  const env = hostRuntimeEnvironment(installedRuntime, root);
  delete env.ICU_DATA;
  if (windows) env.PATH = [path.join(installed, 'bin'), env.PATH].join(';');
  else
    env[process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'] = [
      path.join(installed, 'lib'),
      path.join(installedRuntime, 'lib'),
    ].join(':');
  return env;
}

function installNpmLeaf(archive: string, modules: string) {
  // Read the selected package identity from the actual final archive, not a host-name map.
  const entry = readPortableArchiveEntries(archive).get('package/package.json');
  assert(entry?.isFile);
  const manifest = JSON.parse(entry.data().toString());
  assert.match(manifest.name, /^@oliphaunt\/[a-z0-9][a-z0-9._-]*$/u);
  assert.equal(manifest.oliphaunt?.runtimeRelativePath, 'runtime');
  const installed = path.join(modules, ...manifest.name.split('/'));
  extractPortableArchiveTree(archive, installed, 'package');
  return { manifest, installed };
}

const env = runtimeEnvironment(native);
const run = (binary: string, args: string[], overrides: NodeJS.ProcessEnv = {}) =>
  runHostBinary(binary, args, { ...env, ...overrides }, root);
// Raw ICU and prepared cluster seeds have separate public products. Bootstrap
// this libc smoke through the existing minimal native-initdb contract.
const bootstrap = {
  OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
  OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
};
const control = path.join(runtime, `bin/pg_ctl${suffix}`);
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

try {
  // Bazel input aliases are resolved at this boundary; archive validation still
  // requires regular private files and never follows links inside an archive.
  const archives = [
    runtimeArchive,
    runtimeNpmArchive,
    toolsArchive,
    facadeArchive,
    leafArchive,
  ].map((source, index) => {
    const destination = path.join(root, `input-${index}-${path.basename(source)}`);
    copyFileSync(source, destination);
    return destination;
  });
  const [privateRuntime, privateRuntimeNpm, privateTools, privateFacade, privateLeaf] = archives;
  const privateNpmConsumer = path.join(root, 'npm-consumer.mts');
  copyFileSync(npmConsumer, privateNpmConsumer);
  extractPortableArchiveTree(privateRuntime, native);
  extractPortableArchiveTree(privateTools, path.dirname(tools));
  copyFileSync(profileConsumer, consumer);
  chmodSync(consumer, 0o755);
  const modules = path.join(root, 'node_modules');
  const runtimeLeaf = installNpmLeaf(privateRuntimeNpm, modules);
  assert.equal(runtimeLeaf.manifest.oliphaunt?.libraryRelativePath, library);
  for (const [origin, installed] of [
    ['github', native],
    ['npm', runtimeLeaf.installed],
  ]) {
    const installedRuntime = path.join(installed, 'runtime');
    const installedEnv = runtimeEnvironment(installed);
    const runInstalled = (binary: string, args: string[], overrides: NodeJS.ProcessEnv = {}) =>
      runHostBinary(binary, args, { ...installedEnv, ...overrides }, root);
    const embeddedRoot = path.join(root, `${origin}-embedded-database`);
    const embedded = path.join(embeddedRoot, 'pgdata');
    mkdirSync(embeddedRoot);
    runInstalled(
      path.join(installedRuntime, `bin/initdb${suffix}`),
      [
        '-D',
        embedded,
        '-U',
        'postgres',
        '--locale-provider=libc',
        '--locale=C',
        '--encoding=UTF8',
        '--auth=trust',
        '--no-sync',
      ],
      bootstrap,
    );
    writeFileSync(
      path.join(embeddedRoot, '.oliphaunt.json'),
      `${JSON.stringify({
        schema: 'oliphaunt-database-root-v1',
        engineFamily: 'native',
        pgdata: 'pgdata',
        postgresMajor: 18,
        physicalFormat: 'native-pg18-v1',
      })}\n`,
    );
    runInstalled(consumer, [
      embedded,
      installedRuntime,
      'CREATE TABLE persisted(value integer); INSERT INTO persisted VALUES (42); SELECT 42',
      '42',
    ]);
    runInstalled(consumer, [embedded, installedRuntime, 'SELECT value FROM persisted', '42']);
    runInstalled(consumer, [
      embedded,
      installedRuntime,
      "DO $$ BEGIN PERFORM 42; END $$; SELECT to_tsvector('english', 'running')",
      'run',
    ]);
    const held = path.join(installed, library);
    renameSync(held, `${held}.removed`);
    try {
      const missing = Bun.spawnSync([consumer, embedded, installedRuntime, 'SELECT 42', '42'], {
        env: installedEnv,
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assertMissingHostRuntime(missing, path.basename(library));
    } finally {
      renameSync(`${held}.removed`, held);
    }
  }

  const facade = path.join(modules, '@oliphaunt/tools');
  extractPortableArchiveTree(privateFacade, facade, 'package');
  const { manifest: leafManifest, installed: leaf } = installNpmLeaf(privateLeaf, modules);
  const packedFacade = JSON.parse(readFileSync(path.join(facade, 'package.json'), 'utf8'));
  assert.equal(packedFacade.optionalDependencies[leafManifest.name], leafManifest.version);
  env.PGUSER = 'oliphaunt_carrier_test';
  env.PGDATABASE = 'postgres';
  env.PGPORT = await freeTcpPort();
  env.PGHOST = windows ? '127.0.0.1' : socket;
  const connectionEnvironment = {
    PGUSER: env.PGUSER,
    PGDATABASE: env.PGDATABASE,
    PGPORT: env.PGPORT,
    PGHOST: env.PGHOST,
  };
  const toolsEnv = { ...hostRuntimeEnvironment(tools, root), ...connectionEnvironment };
  const runTools = (binary: string, args: string[]) => runHostBinary(binary, args, toolsEnv, root);
  mkdirSync(database);
  run(
    path.join(runtime, `bin/initdb${suffix}`),
    [
      '-D',
      database,
      '-U',
      env.PGUSER,
      '--locale=C',
      '--encoding=UTF8',
      '--auth=trust',
      '--no-sync',
    ],
    bootstrap,
  );
  const options = windows ? `-h 127.0.0.1 -p ${env.PGPORT}` : `-k ${socket} -h '' -p ${env.PGPORT}`;
  const start = (directory: string) => {
    running = directory;
    runHostBinary(
      control,
      [
        '-D',
        directory,
        '-l',
        path.join(root, `${path.basename(directory)}.log`),
        '-o',
        options,
        '-w',
        'start',
      ],
      env,
      root,
      'inherit',
    );
  };
  start(database);
  const connection = `host=${env.PGHOST} port=${env.PGPORT} user=${env.PGUSER} dbname=postgres`;
  runHostBinary(
    node,
    [privateNpmConsumer, path.join(facade, 'index.js'), connection, fixture],
    {
      ...hostRuntimeEnvironment(path.join(leaf, 'runtime'), root),
      ...connectionEnvironment,
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    root,
  );
  runTools(path.join(tools, `bin/pg_basebackup${suffix}`), [
    '-D',
    restored,
    '--format=plain',
    '--wal-method=stream',
    '--checkpoint=fast',
    '--no-sync',
  ]);
  assert(
    readFileSync(path.join(restored, 'backup_manifest'), 'utf8').includes(
      'PostgreSQL-Backup-Manifest-Version',
    ),
  );
  run(control, ['-D', database, '-m', 'fast', '-w', 'stop']);
  running = undefined;
  start(restored);
  const logicalFixture = JSON.parse(readFileSync(fixture, 'utf8'));
  assert.equal(
    runTools(path.join(tools, `bin/psql${suffix}`), [
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      VERIFY_SQL,
    ]).trim(),
    expectedLogicalValue(logicalFixture),
  );
  run(control, ['-D', restored, '-m', 'fast', '-w', 'stop']);
  running = undefined;
  console.log(
    'Installed native carriers: GitHub and npm libc-profile relocated C query/reopen/modules and missing-library guards; isolated npm facade dump/restore and GitHub tools backup/reopen passed.',
  );
} finally {
  if (running)
    Bun.spawnSync([control, '-D', running, '-m', 'immediate', '-w', 'stop'], {
      env,
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  if (socket) rmSync(socket, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
