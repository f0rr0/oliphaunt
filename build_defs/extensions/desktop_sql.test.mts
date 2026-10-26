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
import { parseArgs } from 'node:util';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import {
  assertMissingHostRuntime,
  extractNativePayload,
  hostRuntimeEnvironment,
  missingHostModuleError,
  runHostBinary,
} from '../native/host-runtime-test-helpers.mts';
import {
  assertSharedDesktopLicense,
  desktopMemberModuleRoots,
  validateDesktopConstruction,
} from './construction.mts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'runtime-prefix': { type: 'string', default: '.' },
    'library-prefix': { type: 'string', default: process.platform === 'win32' ? 'bin' : 'lib' },
    'published-runtime': { type: 'boolean', default: false },
    'restricted-launcher': { type: 'string' },
  },
});
for (const prefix of [values['runtime-prefix'], values['library-prefix']])
  assert(
    prefix === '.' || /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(prefix),
    'host layout must stay within its declared carrier',
  );
const inputs = positionals.map((file) => resolve(file));
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
const carrier = join(root, 'carrier');
const runtime = join(carrier, values['runtime-prefix']);
const libraryDirectory = join(carrier, values['library-prefix']);
const windows = process.platform === 'win32';
const suffix = windows ? '.exe' : '';
const launcher = join(root, 'launcher', 'restricted process.exe');
const libraryName = windows
  ? 'oliphaunt.dll'
  : process.platform === 'darwin'
    ? 'liboliphaunt.dylib'
    : 'liboliphaunt.so';
const library = join(libraryDirectory, libraryName);
const consumer = join(root, 'consumer', 'bin', windows ? 'extension smoke.exe' : 'extension-smoke');
const dependencySmoke = join(root, 'dependency-load.sql');
const fullSmoke = join(root, 'catalog-smoke.sql');
const serverSuccessRow = '?column? = "candidate-extension-smoke-ok"';
const moduleRoots = new Set<string>();
const memberModuleRoots = new Map<string, Set<string>>();
const env = hostRuntimeEnvironment(runtime, root);
if (windows) {
  env.PATH = `${join(carrier, 'bin')};${env.PATH}`;
  // Published Windows ICU uses its exact colocated data DLL, not a .dat path.
  if (values['published-runtime']) delete env.ICU_DATA;
} else {
  env[process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'] =
    `${libraryDirectory}:${join(runtime, 'lib')}`;
}
env.OLIPHAUNT_SMOKE_MODULE_DIR = join(carrier, 'lib', 'modules');
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
const embedded = (pgdata: string, planSmoke = fullSmoke) =>
  Bun.spawnSync([consumer, pgdata, runtime, '--sql-plan', install, planSmoke, startup], {
    env,
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
const server = (pgdata: string, planSmoke = fullSmoke) =>
  Bun.spawnSync(
    [
      ...(windows ? [launcher] : []),
      join(runtime, 'bin', `postgres${suffix}`),
      '--single',
      '-j',
      '-D',
      pgdata,
      ...startupArgs,
      'postgres',
    ],
    {
      env,
      cwd: root,
      stdin: Buffer.from(
        `BEGIN;\n\n${text(install)}${text(planSmoke)}\nCOMMIT;\n\n`.replace(
          /^-- oliphaunt-statement$/gmu,
          '',
        ),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

try {
  if (values['published-runtime']) extractPortableArchiveTree(realpathSync(payload), carrier);
  else await extractNativePayload(payload, carrier);
  const selectedFiles = new Map<string, { declared: boolean; mode: number }>();
  const memberDependencies = new Map<string, string>();
  for (const archive of archives) {
    const entries = readPortableArchiveEntries(archive, { format: 'tar.gz' });
    // validateDesktopConstruction has already checked these descriptors, every
    // recorded byte digest, both module ABIs, and the full resource inventory.
    const descriptorEntry = entries.get('extension.json');
    assert(descriptorEntry);
    const descriptor = JSON.parse(descriptorEntry.data().toString('utf8'));
    const constructionLicenses = new Set<string>(descriptor.construction_licenses ?? []);
    const ownedRoots = desktopMemberModuleRoots(entries, descriptor.module_file);
    memberModuleRoots.set(descriptor.sql_name, new Set(ownedRoots));
    for (const filename of ownedRoots) moduleRoots.add(filename);
    for (const name of descriptor.dependency_modules ?? []) {
      assert(!memberDependencies.has(name), 'candidate members repeat a dependency module');
      memberDependencies.set(name, descriptor.sql_name);
    }
    for (const [name, entry] of entries) {
      if (name === 'extension.json') continue;
      assert(entry.isFile, 'candidate members contain non-files');
      const output = join(name.startsWith('lib/modules/') ? carrier : runtime, name);
      const current = { declared: constructionLicenses.has(name), mode: entry.mode };
      const original = selectedFiles.get(name);
      if (original) {
        assertSharedDesktopLicense(
          name,
          { ...original, data: readFileSync(output) },
          { ...current, data: entry.data() },
        );
        continue;
      }
      selectedFiles.set(name, current);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.data(), { mode: entry.mode });
      chmodSync(output, entry.mode);
    }
  }
  // Both plans exercise the candidate's declared PG roots, including companions.
  // Plain support libraries are exercised through their owning PG modules.
  const separator = '\n-- oliphaunt-statement\n';
  const loads = [...moduleRoots].sort().map((name) => `LOAD '$libdir/${name}';`);
  writeFileSync(
    dependencySmoke,
    `${[...loads, "SELECT 'candidate-extension-smoke-ok';"].join(separator)}\n`,
  );
  writeFileSync(fullSmoke, `${[...loads, text(smoke)].join(separator)}\n`);
  assert(statSync(library).isFile(), 'candidate runtime is missing its native library');
  mkdirSync(dirname(consumer), { recursive: true });
  copyFileSync(sourceConsumer, consumer);
  if (!windows) chmodSync(consumer, 0o755);
  else {
    const sourceLauncher = values['restricted-launcher'];
    assert(sourceLauncher, 'Windows server SQL requires its restricted launcher');
    mkdirSync(dirname(launcher), { recursive: true });
    copyFileSync(resolve(sourceLauncher), launcher);
  }
  for (const setting of text(environment).split('\n').filter(Boolean)) {
    const [name, path, required] = setting.split('\t');
    assert(name && path && required && statSync(join(runtime, path, required)).isFile());
    env[name] = join(runtime, path);
  }
  const dependencyNames = text(dependencies).split('\n').filter(Boolean);
  assert.deepEqual(
    dependencyNames,
    [...memberDependencies.keys()].sort(),
    'canonical dependency plan must equal the actual candidate member inventories',
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

  const pgdata = initialize('embedded');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = embedded(pgdata);
    assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
  }
  const result = server(initialize(windows ? 'server with spaces' : 'server'));
  const response = result.stderr.toString() + result.stdout.toString();
  assert.equal(result.exitCode, 0, response);
  assert(response.includes(serverSuccessRow) && !/ERROR:|FATAL:|not ok/u.test(response), response);

  if (windows) {
    assert(
      result.stdout.toString().includes(serverSuccessRow),
      'restricted server must preserve SQL stdin/stdout',
    );
    const missing = 'missing server database';
    const rejected = server(join(root, missing));
    const diagnostic = rejected.stderr.toString() + rejected.stdout.toString();
    assert.equal(rejected.exitCode, 1, diagnostic);
    assert(
      rejected.stderr.toString().includes(missing),
      'restricted server must preserve its error stream',
    );
  }

  for (const name of dependencyNames) {
    const owner = memberDependencies.get(name);
    assert(owner);
    for (const profile of ['modules', 'postgresql']) {
      assert(selectedFiles.has(`lib/${profile}/${name}`));
      const module = join(profile === 'modules' ? carrier : runtime, 'lib', profile, name);
      const pgdata = initialize(`missing-dependency-${profile}-${name}`);
      renameSync(module, `${module}.disabled`);
      try {
        const result =
          profile === 'modules'
            ? embedded(pgdata, dependencySmoke)
            : server(pgdata, dependencySmoke);
        const response = result.stderr.toString() + result.stdout.toString();
        // LoadLibrary reports the owning module when an imported DLL is absent;
        // POSIX loaders also identify the missing dependency itself.
        assert(
          missingHostModuleError(response, name, process.platform, [
            ...(memberModuleRoots.get(owner) ?? []),
          ]),
          `${profile} ${name} (exit ${result.exitCode}): expected missing dependency or Windows owner identity\n${response}`,
        );
        if (profile === 'modules')
          assert.equal(result.exitCode, 1, 'embedded consumer did not report a missing dependency');
        else {
          assert([0, 1].includes(result.exitCode), 'server did not report a PostgreSQL rejection');
          assert(/ERROR:|FATAL:/u.test(response), 'server consumer accepted a missing dependency');
          assert(
            !response.includes(serverSuccessRow),
            'server completed after a missing dependency',
          );
        }
      } finally {
        renameSync(`${module}.disabled`, module);
      }
    }
  }

  const missingMember = plan.members.find((member: { module_file: string }) => member.module_file);
  assert(missingMember, 'desktop member inventory must include compiled modules');
  for (const profile of ['modules', 'postgresql']) {
    const module = join(
      profile === 'modules' ? carrier : runtime,
      'lib',
      profile,
      missingMember.module_file,
    );
    const pgdata = initialize(`missing-${profile}`);
    renameSync(module, `${module}.disabled`);
    try {
      const result =
        profile === 'modules' ? embedded(pgdata, dependencySmoke) : server(pgdata, dependencySmoke);
      const response = result.stderr.toString() + result.stdout.toString();
      assert(
        missingHostModuleError(response, missingMember.module_file, process.platform, [
          ...(memberModuleRoots.get(missingMember.sql_name) ?? []),
        ]),
        `${profile} ${missingMember.sql_name} (exit ${result.exitCode}): expected missing module identity\n${response}`,
      );
      if (profile === 'modules')
        assert.equal(
          result.exitCode,
          1,
          'embedded consumer did not report a missing candidate module',
        );
      else {
        assert([0, 1].includes(result.exitCode), 'server did not report a PostgreSQL rejection');
        assert(
          /ERROR:|FATAL:/u.test(response),
          'server consumer accepted a missing candidate module',
        );
        assert(!response.includes(serverSuccessRow), 'server completed after a missing module');
      }
    } finally {
      renameSync(`${module}.disabled`, module);
    }
  }

  console.log(
    `${construction.members.length} candidate desktop members: embedded reopen, server SQL and missing candidate loader/module/dependency probes PASS`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
