import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { removeOwnedDirectory } from '../../tools/packaging/release-directory-safety.mts';
import { hostRuntimeEnvironment } from './host-runtime-test-helpers.mts';

export function assertExecutedRustTests(output: string): void {
  const summaries = [...output.matchAll(/^test result: ok[.] (\d+) passed; 0 failed;/gmu)];
  assert(summaries.length > 0, 'Rust harness did not report a successful test result');
  assert(Number(summaries.at(-1)![1]) > 0, 'Rust runtime qualification executed zero tests');
}

export function nativeRustTestEnvironment(
  native: string,
  tools: string,
  broker: string,
  root: string,
): NodeJS.ProcessEnv {
  assert.equal(process.platform, 'linux', 'Native Rust lifecycle qualification runs on Linux');
  const installed = path.join(native, 'runtime');
  const env = hostRuntimeEnvironment(installed, root);
  delete env.ICU_DATA;
  Object.assign(env, {
    LIBOLIPHAUNT_PATH: path.join(native, 'lib/liboliphaunt.so'),
    OLIPHAUNT_INSTALL_DIR: installed,
    OLIPHAUNT_INITDB: path.join(installed, 'bin/initdb'),
    OLIPHAUNT_POSTGRES: path.join(installed, 'bin/postgres'),
    OLIPHAUNT_EMBEDDED_MODULE_DIR: path.join(native, 'lib/modules'),
    OLIPHAUNT_TOOLS_DIR: path.join(tools, 'runtime'),
    OLIPHAUNT_BROKER: path.join(broker, 'bin/oliphaunt-broker'),
    OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
    OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
    OLIPHAUNT_RUNTIME_CACHE_DIR: path.join(root, 'native-cache'),
    LD_LIBRARY_PATH: [
      path.join(native, 'lib'),
      path.join(installed, 'lib'),
      path.join(tools, 'runtime/lib'),
    ].join(':'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
  });
  for (const file of [
    env.LIBOLIPHAUNT_PATH,
    env.OLIPHAUNT_INITDB,
    env.OLIPHAUNT_POSTGRES,
    env.OLIPHAUNT_BROKER,
    path.join(tools, 'runtime/bin/psql'),
    path.join(tools, 'runtime/bin/pg_basebackup'),
  ]) {
    assert(
      file && lstatSync(file).isFile(),
      'Native Rust qualification needs its exact installed carrier Files',
    );
  }
  mkdirSync(env.TMPDIR!, { recursive: true });
  return env;
}

/** Let the production SDK select and materialize original extension sidecars. */
export function stageNativeRustExtensions(
  root: string,
  names: readonly string[],
  archives: readonly string[],
): string | undefined {
  assert.equal(
    names.length,
    archives.length,
    'Every extension needs its original declared archive',
  );
  assert.equal(new Set(names).size, names.length, 'Extension Files cannot repeat a SQL member');
  assert.deepEqual(
    names,
    [...names].sort(),
    'Extension Files must follow canonical SQL-name order',
  );
  for (const name of names)
    assert(/^[a-z][a-z0-9_-]*$/u.test(name), 'Extension sidecar needs a canonical SQL name');
  if (names.length === 0) return undefined;
  const resources = path.join(root, 'resources');
  for (const [index, source] of archives.entries()) {
    const archive = path.join(root, `extension-${index}.tar.gz`);
    // The outer Bazel File alias is transport; archive members remain strictly validated.
    copyFileSync(source, archive);
    const destination = path.join(resources, 'extension', names[index]);
    extractPortableArchiveTree(archive, destination);
    const descriptor = JSON.parse(readFileSync(path.join(destination, 'extension.json'), 'utf8'));
    assert.equal(descriptor.schema, 'oliphaunt-extension-member-payload-v1');
    assert.equal(
      descriptor.sql_name,
      names[index],
      'Extension archive differs from its configured member',
    );
    assert.equal(descriptor.family, 'native');
    assert.equal(descriptor.configuration, 'linux-x64-gnu');
  }
  return resources;
}

if (import.meta.main) {
  const [
    binary,
    runtimeArchive,
    toolsArchive,
    brokerArchive,
    argsJson,
    namesJson,
    workspace,
    ...trailingArguments
  ] = Bun.argv.slice(2);
  assert(
    workspace && workspace === path.basename(workspace) && workspace !== '.' && workspace !== '..',
    'Expected declared runfiles workspace',
  );
  assert(
    binary && runtimeArchive && toolsArchive && brokerArchive && argsJson && namesJson,
    'Expected Rust executable and exact final native carrier Files',
  );
  const args = JSON.parse(argsJson) as unknown;
  const names = JSON.parse(namesJson) as unknown;
  assert(
    Array.isArray(names) && names.every((name) => typeof name === 'string'),
    'Expected configured extension SQL names',
  );
  const extensionArchives = trailingArguments.slice(0, names.length);
  const runfilesRoot = trailingArguments[names.length];
  assert(
    runfilesRoot && path.isAbsolute(runfilesRoot),
    'Expected original directory runfiles root',
  );
  assert(
    Array.isArray(args) && args.every((value) => typeof value === 'string'),
    'Expected Rust harness arguments',
  );
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'native-rust-'));
  try {
    const destinations = ['native', 'tools', 'broker'].map((name) => path.join(root, name));
    for (const [index, source] of [runtimeArchive, toolsArchive, brokerArchive].entries()) {
      const archive = path.join(root, 'input-' + index + '.tar.gz');
      // Resolve only the outer declared File alias before strict archive validation.
      copyFileSync(source, archive);
      extractPortableArchiveTree(archive, destinations[index]);
    }
    const env = nativeRustTestEnvironment(destinations[0], destinations[1], destinations[2], root);
    // Preserve the original test data namespace when native code changes cwd.
    env.TEST_SRCDIR = runfilesRoot;
    env.TEST_WORKSPACE = workspace;
    const resources = stageNativeRustExtensions(root, names, extensionArchives);
    if (resources) {
      env.OLIPHAUNT_RESOURCES_DIR = resources;
      env.OLIPHAUNT_NATIVE_EXTENSION_PROOF_SQL_NAMES = names.join(',');
      env.OLIPHAUNT_EXTENSION_MATRIX = '1';
    }
    const result = Bun.spawnSync(
      [path.resolve(binary), ...args, ...trailingArguments.slice(names.length + 1)],
      {
        cwd: path.join(runfilesRoot, workspace),
        env,
        stdin: 'inherit',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 600_000,
      },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.exitCode, 0, 'Native Rust test binary failed');
    assertExecutedRustTests(result.stdout.toString() + '\n' + result.stderr.toString());
  } finally {
    removeOwnedDirectory(root);
  }
}
