/** Original upstream SQL/C regressions and the shared persisted 0.6.1 upgrade proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { endianness, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { extractNativeArchive } from '../../../../../build_defs/extensions/native_carrier_install_helpers.mts';
import {
  extractNativePayload,
  hostRuntimeEnvironment,
  runHostBinary,
} from '../../../../../build_defs/native/host-runtime-test-helpers.mts';

assert.equal(process.platform, 'linux', 'upstream qualification uses the declared Linux profile');
assert.equal(endianness(), 'LE', 'the two upstream native-endian fixtures require this LE profile');
assert.equal(
  process.argv.length,
  12,
  'expected actual runtime, modules, regression driver and C tests',
);
const [
  runtimeArchive,
  toolsArchive,
  currentArchive,
  oldModule,
  oldControl,
  currentMakefile,
  regress,
  ...cTests
] = process.argv.slice(2).map((file) => resolve(file));
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'pg-textsearch-upgrade-'));
const socket = mkdtempSync('/tmp/oliphaunt-textsearch-');
const runtime = join(root, 'runtime');
const tools = join(root, 'tools');
const current = join(root, 'current');
const database = join(root, 'data');
const source = dirname(currentMakefile);
const extension = join(runtime, 'share/postgresql/extension');
const module = join(runtime, 'lib/postgresql/pg_textsearch.so');
const log = join(root, 'postgres.log');
const env = {
  ...hostRuntimeEnvironment(runtime, root),
  PGHOST: socket,
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGDATABASE: 'postgres',
};
let running = false;
let failed = false;
const run = (binary: string, args: string[]) => runHostBinary(binary, args, env, root);
const psql = (database: string, args: string[]) =>
  run(join(tools, 'bin/psql'), ['-X', '-v', 'ON_ERROR_STOP=1', '-d', database, ...args]);
const sql = (database: string, statement: string) =>
  psql(database, ['-A', '-t', '-c', statement]).trim();
const sharedSql = (name: string) => join(import.meta.dirname, `${name}.sql`);

function start() {
  running = true;
  run(join(runtime, 'bin/pg_ctl'), ['-D', database, '-l', log, '-w', 'start']);
}

function stop() {
  run(join(runtime, 'bin/pg_ctl'), ['-D', database, '-m', 'fast', '-w', 'stop']);
  running = false;
}

function install(moduleFile: string, directory: string) {
  copyFileSync(moduleFile, module);
  chmodSync(module, 0o755);
  copyFileSync(join(directory, 'pg_textsearch.control'), join(extension, 'pg_textsearch.control'));
  chmodSync(join(extension, 'pg_textsearch.control'), 0o644);
  for (const file of readdirSync(extension))
    if (/^pg_textsearch--.*\.sql$/u.test(file)) rmSync(join(extension, file));
  const sqlRoot = existsSync(join(directory, 'sql')) ? join(directory, 'sql') : directory;
  const files = readdirSync(sqlRoot).filter((name) => /^pg_textsearch--.*\.sql$/u.test(name));
  assert(files.length > 0, 'the declared source must retain its SQL install/upgrade chain');
  for (const file of files) {
    copyFileSync(join(sqlRoot, file), join(extension, file));
    chmodSync(join(extension, file), 0o644);
  }
}

/** Match the two fixed COPY BINARY producers in the pinned upstream test sources. */
function vectorFixtures() {
  const word = (value: number, endian: 'BE' | 'LE') => {
    const bytes = Buffer.alloc(4);
    if (endian === 'BE') bytes.writeInt32BE(value);
    else bytes.writeInt32LE(value);
    return bytes;
  };
  const name = Buffer.alloc(16);
  name.write('compat_idx');
  const entry = (frequency: number, lexeme: string) => {
    const bytes = Buffer.alloc(16);
    bytes.writeInt32LE(frequency, 0);
    bytes.writeInt32LE(Buffer.byteLength(lexeme), 4);
    bytes.write(lexeme, 8);
    return bytes;
  };
  const legacy = Buffer.concat([
    word(60, 'BE'),
    word(10, 'LE'),
    word(2, 'LE'),
    name,
    entry(1, 'alpha'),
    entry(2, 'bravo'),
  ]);
  const nul = Buffer.concat([
    word(45, 'BE'),
    Buffer.from('BM25'),
    Buffer.from([2, 0, 0, 0]),
    word(10, 'LE'),
    word(1, 'LE'),
    name,
    Buffer.from([1, 7]),
    Buffer.from('bad\0lex'),
  ]);
  const copy = (value: Buffer) =>
    Buffer.concat([
      Buffer.from('PGCOPY\n\xff\r\n\0', 'latin1'),
      Buffer.alloc(8),
      Buffer.from([0, 2]),
      word(4, 'BE'),
      word(42, 'BE'),
      word(value.length, 'BE'),
      value,
      Buffer.from([255, 255]),
    ]);
  return [
    {
      script: 'gen_v1_bm25vector.py',
      sourceSha: '9a8a345a1bbf00c8bcf55d1fb7c9daec478c68ea7ee2b31d3a7c9a9047cbfbc1',
      output: 'legacy-vector.bin',
      bytes: copy(legacy),
      sha: '85ea5f9e125da70a0cfa1bfe8a07904e9e7a3ad9ce7f74c1c91fcbe7bd800f1a',
    },
    {
      script: 'gen_nul_lexeme_bm25vector.py',
      sourceSha: '4c173535c653a5b4a86e761490c3bb1cc4dac189a0b585e740b9ccebdc7116d2',
      output: 'nul-vector.bin',
      bytes: copy(nul),
      sha: '05a6307ba70a75adde3a727a662df52c482b6e0a67c4e5b5673c4687b8321350',
    },
  ];
}

function upstreamInputs(): string[] {
  const makefile = readFileSync(currentMakefile, 'utf8');
  const initial = /^REGRESS = (.+)$/mu.exec(makefile);
  assert(initial, 'upstream must declare its production regression schedule');
  const schedule = [
    initial[1],
    ...[...makefile.matchAll(/^REGRESS \+= ([a-z0-9_ ]+)$/gmu)].map((match) => match[1]),
  ]
    .join(' ')
    .trim()
    .split(/\s+/u);
  assert.equal(schedule.length, 82, 'review a changed upstream production regression schedule');
  assert.equal(new Set(schedule).size, schedule.length);
  assert.equal(schedule[0], 'preload');
  // The configured native host has injection points disabled; upstream itself
  // adds INJECTION_REGRESS only to an injection-enabled PostgreSQL build.
  assert(
    makefile.includes('ifeq ($(enable_injection_points),yes)\nREGRESS += $(INJECTION_REGRESS)'),
  );
  for (const directory of ['sql', 'expected']) {
    mkdirSync(join(root, 'test', directory), { recursive: true });
    const suffix = directory === 'sql' ? '.sql' : '.out';
    for (const file of readdirSync(join(source, 'test', directory)))
      if (file.endsWith(suffix)) {
        copyFileSync(join(source, 'test', directory, file), join(root, 'test', directory, file));
        chmodSync(join(root, 'test', directory, file), 0o644);
      }
  }
  for (const test of schedule) {
    assert(existsSync(join(root, 'test/sql', `${test}.sql`)), `missing declared SQL ${test}`);
    assert(
      existsSync(join(root, 'test/expected', `${test}.out`)),
      `missing declared expectation ${test}`,
    );
  }
  mkdirSync(join(root, 'test/fixtures'));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  for (const fixture of vectorFixtures()) {
    assert.equal(
      digest(readFileSync(join(source, 'test/scripts', fixture.script))),
      fixture.sourceSha,
    );
    assert.equal(
      digest(fixture.bytes),
      fixture.sha,
      'TS fixture differs from the pinned upstream binary format',
    );
    writeFileSync(join(root, 'test/fixtures', fixture.output), fixture.bytes);
    for (const file of ['sql/vector_v1_rejected.sql', 'expected/vector_v1_rejected.out']) {
      const target = join(root, 'test', file);
      const before = readFileSync(target, 'utf8');
      const command = `PROGRAM 'python3 test/scripts/${fixture.script}'`;
      assert.equal(
        before.split(command).length,
        2,
        'review a changed upstream COPY fixture command',
      );
      writeFileSync(target, before.replace(command, `'test/fixtures/${fixture.output}'`));
    }
  }
  for (const file of ['sql/binary_io.sql', 'expected/binary_io.out']) {
    const target = join(root, 'test', file);
    let text = readFileSync(target, 'utf8');
    for (const name of ['query_export.bin', 'vector_export.bin']) {
      assert.equal(text.split(`/tmp/${name}`).length, 4, 'review upstream binary I/O isolation');
      text = text.replaceAll(`/tmp/${name}`, `test/fixtures/${name}`);
    }
    writeFileSync(target, text);
  }
  return schedule;
}

try {
  await extractNativePayload(runtimeArchive, runtime);
  await extractNativePayload(toolsArchive, tools);
  extractNativeArchive(currentArchive, current);
  cpSync(current, runtime, { recursive: true });
  const currentExtension = join(current, 'share/postgresql/extension');
  const currentVersion = /default_version\s*=\s*'([^']+)'/u.exec(
    readFileSync(join(currentExtension, 'pg_textsearch.control'), 'utf8'),
  )?.[1];
  const oldVersion = /default_version\s*=\s*'([^']+)'/u.exec(readFileSync(oldControl, 'utf8'))?.[1];
  assert.equal(oldVersion, '0.6.1');
  assert.equal(currentVersion, '1.5.1');
  for (const binary of cTests) run(binary, []);
  install(oldModule, dirname(oldControl));
  run(join(runtime, 'bin/initdb'), [
    '-D',
    database,
    '-U',
    env.PGUSER,
    '--auth-local=trust',
    '--auth-host=reject',
    '--locale=C',
    '--encoding=UTF8',
    '--no-sync',
  ]);
  writeFileSync(
    join(database, 'postgresql.conf'),
    [
      readFileSync(join(database, 'postgresql.conf'), 'utf8'),
      "listen_addresses = ''",
      `unix_socket_directories = '${socket}'`,
      "shared_preload_libraries = 'pg_textsearch'",
      'shared_buffers = 256MB',
      'max_connections = 20',
    ].join('\n') + '\n',
  );
  start();
  sql('postgres', 'CREATE DATABASE pg_textsearch_upgrade');
  psql('pg_textsearch_upgrade', ['-v', `old_version=${oldVersion}`, '-f', sharedSql('seed')]);
  stop();
  install(join(current, 'lib/postgresql/pg_textsearch.so'), currentExtension);
  start();
  // This shared SQL first reads the old persisted postings with the new library,
  // then ALTERs the extension and performs inserts/updates/deletes/compaction.
  psql('pg_textsearch_upgrade', ['-f', sharedSql('upgrade')]);
  const verify = (name: string) => {
    psql(name, ['-f', sharedSql('verify')]);
    assert.equal(
      sql(name, "SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch'"),
      currentVersion,
    );
  };
  verify('pg_textsearch_upgrade');
  stop();
  start();
  verify('pg_textsearch_upgrade');
  const dump = run(join(tools, 'bin/pg_dump'), [
    '-d',
    'pg_textsearch_upgrade',
    '--no-owner',
    '--no-privileges',
  ]);
  const dumped = join(root, 'upgrade.sql');
  writeFileSync(dumped, dump);
  sql('postgres', 'CREATE DATABASE pg_textsearch_upgrade_restore');
  psql('pg_textsearch_upgrade_restore', ['-f', dumped]);
  verify('pg_textsearch_upgrade_restore');
  const schedule = upstreamInputs();
  // Original pg_regress owns psql execution and exact expected/alternate matching.
  // Benchmark harness self-tests, optional replication and injection suites are
  // outside this artifact gate; none of the production REGRESS cases are dropped.
  run(regress, [
    '--bindir=' + join(tools, 'bin'),
    '--inputdir=test',
    '--outputdir=test',
    '--host=' + socket,
    '--port=5432',
    '--user=' + env.PGUSER,
    '--dbname=contrib_regression',
    ...schedule,
  ]);
  stop();
  console.log(
    `pg_textsearch ${oldVersion} -> ${currentVersion}: persisted upgrade/restart/dump-restore, ${schedule.length} upstream SQL cases and ${cTests.length} native C executions PASS`,
  );
} catch (error) {
  failed = true;
  for (const file of [log, join(root, 'test/regression.diffs')])
    if (existsSync(file)) console.error(readFileSync(file, 'utf8').slice(-64000));
  throw error;
} finally {
  let mayRemove = true;
  if (running && existsSync(join(database, 'postmaster.pid'))) {
    const result = Bun.spawnSync(
      [join(runtime, 'bin/pg_ctl'), '-D', database, '-m', 'immediate', '-w', 'stop'],
      { env, cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    if (result.exitCode !== 0) {
      mayRemove = false;
      const error = new Error(
        `server stop failed; preserving ${root}: ${result.stderr.toString()}`,
      );
      if (!failed) throw error;
      console.error(error);
    }
  }
  if (mayRemove) {
    rmSync(socket, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}
