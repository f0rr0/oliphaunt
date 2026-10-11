/** The canonical extension SQL plan against relocated candidate desktop bytes. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  assertMissingHostRuntime,
  extractNativePayload,
  hostRuntimeEnvironment,
  runHostBinary,
} from '../native/host-runtime-test-helpers.mts';
import { validateDesktopConstruction } from './construction.mts';

const inputs = process.argv.slice(2).map((file) => resolve(file));
assert(
  inputs.length > 8,
  'expected runtime, consumer, five SQL plan files, inventory, and archives',
);
const [payload, sourceConsumer, install, smoke, startup, environment, dependencies, inventory] =
  inputs;
assert(
  payload &&
    sourceConsumer &&
    install &&
    smoke &&
    startup &&
    environment &&
    dependencies &&
    inventory,
);
// Resolve only the declared Bazel runfile projection before the strict reader.
const archives = inputs.slice(8).map((file) => realpathSync(file));
const text = (file: string) => new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
const plan = JSON.parse(text(inventory));
const construction = validateDesktopConstruction(plan, archives);
const configurations: Record<string, string> = {
  'linux/x64': 'linux-x64-gnu',
  'linux/arm64': 'linux-arm64-gnu',
  'darwin/arm64': 'macos-arm64',
  'win32/x64': 'windows-x64-msvc',
};
assert.equal(
  construction.configuration,
  configurations[`${process.platform}/${process.arch}`],
  'desktop installed SQL must execute on the actual candidate native host',
);
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'desktop-extensions-'));
const runtime = join(root, 'runtime');
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';
const libraryName = windows
  ? 'oliphaunt.dll'
  : process.platform === 'darwin'
    ? 'liboliphaunt.dylib'
    : 'liboliphaunt.so';
const library = join(runtime, windows ? 'bin' : 'lib', libraryName);
const consumer = join(root, 'consumer', 'bin', `extension-smoke${suffix}`);
const env = hostRuntimeEnvironment(runtime, root);
env.OLIPHAUNT_SMOKE_MODULE_DIR = join(runtime, 'lib', 'modules');
const run = (binary: string, args: string[], overrides: NodeJS.ProcessEnv = {}) =>
  runHostBinary(binary, args, { ...env, ...overrides }, root);

function initialize(name: string): string {
  const database = join(root, name);
  mkdirSync(database);
  const pgdata = join(database, 'pgdata');
  run(
    join(runtime, 'bin', `initdb${suffix}`),
    [
      '-D',
      pgdata,
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
  writeFileSync(
    join(database, '.oliphaunt.json'),
    `${JSON.stringify({
      schema: 'oliphaunt-database-root-v1',
      engineFamily: 'native',
      pgdata: 'pgdata',
      postgresMajor: 18,
      physicalFormat: 'native-pg18-v1',
    })}\n`,
  );
  return pgdata;
}

const startupArgs = text(startup)
  .split('\n')
  .filter(Boolean)
  .flatMap((assignment) => ['-c', assignment]);
const sql = (text(install) + text(smoke)).replace(/^-- oliphaunt-statement$/gmu, '');
const embedded = (pgdata: string) =>
  Bun.spawnSync([consumer, pgdata, runtime, '--sql-plan', install, smoke, startup], {
    env,
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
const server = (pgdata: string) =>
  Bun.spawnSync(
    [
      join(runtime, 'bin', `postgres${suffix}`),
      '--single',
      '-j',
      '-D',
      pgdata,
      ...startupArgs,
      'postgres',
    ],
    { env, cwd: root, stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );

try {
  await extractNativePayload(payload, runtime);
  const selectedFiles = new Set<string>();
  for (const archive of archives) {
    for (const [name, entry] of readPortableArchiveEntries(archive, { format: 'tar.gz' })) {
      if (name === 'extension.json') continue;
      assert(
        entry.isFile && !selectedFiles.has(name),
        'candidate members overlap or contain non-files',
      );
      selectedFiles.add(name);
      const output = join(runtime, name);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.data(), { mode: entry.mode });
      chmodSync(output, entry.mode);
    }
  }
  assert(statSync(library).isFile(), 'candidate runtime is missing its native library');
  mkdirSync(dirname(consumer), { recursive: true });
  copyFileSync(sourceConsumer, consumer);
  if (!windows) chmodSync(consumer, 0o755);
  for (const setting of text(environment).split('\n').filter(Boolean)) {
    const [name, path, required] = setting.split('\t');
    assert(name && path && required && statSync(join(runtime, path, required)).isFile());
    env[name] = join(runtime, path);
  }
  assert.equal(
    text(dependencies),
    '',
    'this desktop slice excludes the platform-specific PostGIS dependency recipe',
  );

  const baseline = Bun.spawnSync([consumer], { env, cwd: root, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(
    baseline.exitCode,
    2,
    'consumer must load the candidate before the missing-library probe',
  );
  renameSync(library, `${library}.disabled`);
  try {
    assertMissingHostRuntime(
      Bun.spawnSync([consumer], { env, cwd: root, stdout: 'pipe', stderr: 'pipe' }),
      libraryName,
    );
  } finally {
    renameSync(`${library}.disabled`, library);
  }

  const missingMember = plan.members.find((member: { module_file: string }) => member.module_file);
  assert(missingMember, 'desktop member inventory must include compiled modules');
  for (const profile of ['modules', 'postgresql']) {
    const module = join(runtime, 'lib', profile, missingMember.module_file);
    const pgdata = initialize(`missing-${profile}`);
    renameSync(module, `${module}.disabled`);
    try {
      const result = profile === 'modules' ? embedded(pgdata) : server(pgdata);
      const response = result.stderr.toString() + result.stdout.toString();
      assert(
        response.includes(missingMember.sql_name),
        'missing candidate module must fail by its own identity',
      );
      if (profile === 'modules')
        assert.notEqual(
          result.exitCode,
          0,
          'embedded consumer accepted a missing candidate module',
        );
      else
        assert(
          /ERROR:|FATAL:/u.test(response),
          'server consumer accepted a missing candidate module',
        );
    } finally {
      renameSync(`${module}.disabled`, module);
    }
  }

  const pgdata = initialize('embedded');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = embedded(pgdata);
    assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
  }
  const result = server(initialize('server'));
  const response = result.stderr.toString() + result.stdout.toString();
  assert.equal(result.exitCode, 0, response);
  assert(
    response.includes('candidate-extension-smoke-ok') && !/ERROR:|FATAL:|not ok/u.test(response),
    response,
  );
  console.log(
    `${construction.members.length} candidate desktop members: embedded reopen, server SQL and missing candidate loader/module probes PASS`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
