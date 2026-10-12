/** Installed native carrier qualification shared across member and bundle tests. */
import { CString, dlopen } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

export function readNativeCargoPayload(
  directory: string,
  leaf: string,
  version: string,
  licenses: string[] = ['MIT'],
) {
  const cargoPayload = new Map<string, string>();
  const chunks = new Map<string, { index: number; bytes: Buffer }[]>();
  const parts: string[] = [];
  let parentDependencies: Record<string, any> = {};
  let parent = false;
  for (const file of readdirSync(realpathSync(directory)).filter((name) =>
    name.endsWith('.crate'),
  )) {
    const archive = readPortableArchiveEntries(realpathSync(path.join(directory, file)));
    const prefix = file.slice(0, -6);
    const cargo = Bun.TOML.parse(archive.get(`${prefix}/Cargo.toml`)!.data().toString('utf8'));
    assert.equal(cargo.package.version, version);
    if (cargo.package.name === leaf) {
      parent = true;
      parentDependencies = cargo['build-dependencies'] ?? {};
    } else {
      assert(
        cargo.package.name.startsWith(`${leaf}-part-`) &&
          /-part-[0-9]{3}$/u.test(cargo.package.name),
        'undeclared Cargo payload identity',
      );
      parts.push(cargo.package.name);
    }
    for (const license of licenses) assert(cargo.package.license.includes(license));
    for (const [name, entry] of archive)
      if (name.startsWith(`${prefix}/payload/`) && entry.isFile) {
        let relative = name.slice(`${prefix}/payload/`.length);
        if (relative.startsWith('chunks/')) {
          const match = /^(.*)\.part([0-9]{3})$/u.exec(relative.slice('chunks/'.length));
          assert(match, 'invalid split Cargo chunk name');
          const rows = chunks.get(match[1]) ?? [];
          rows.push({ index: Number(match[2]), bytes: entry.data() });
          chunks.set(match[1], rows);
          continue;
        }
        if (relative.startsWith('files/')) relative = relative.slice('files/'.length);
        assert(
          !cargoPayload.has(relative),
          'Cargo payload parts must not duplicate file ownership',
        );
        cargoPayload.set(relative, digest(entry.data()));
      }
  }
  assert(parent, 'missing canonical Cargo parent carrier');
  assert.deepEqual(
    parts.sort(),
    parts.map((_, index) => `${leaf}-part-${String(index + 1).padStart(3, '0')}`),
  );
  assert.deepEqual(
    Object.keys(parentDependencies)
      .filter((name) => name.startsWith(`${leaf}-part-`))
      .sort(),
    parts,
  );
  for (const name of parts) assert.equal(parentDependencies[name].version, `=${version}`);
  for (const [relative, rows] of chunks) {
    assert(!cargoPayload.has(relative), 'split and whole Cargo payload ownership overlap');
    rows.sort((a, b) => a.index - b.index);
    assert.deepEqual(
      rows.map((row) => row.index),
      rows.map((_, index) => index),
      'Cargo chunks must have contiguous unique indexes',
    );
    const hash = createHash('sha256');
    for (const row of rows) hash.update(row.bytes);
    cargoPayload.set(relative, hash.digest('hex'));
  }
  return cargoPayload;
}

export function writableDirectories(directory: string) {
  chmodSync(directory, 0o755);
  for (const row of readdirSync(directory, { withFileTypes: true }))
    if (row.isDirectory()) writableDirectories(path.join(directory, row.name));
}

export function extractNativeArchive(file: string, directory: string, prefix = '') {
  mkdirSync(directory, { recursive: true });
  for (const [name, entry] of readPortableArchiveEntries(realpathSync(file))) {
    if (!entry.isFile || !name.startsWith(prefix)) continue;
    const output = path.join(directory, name.slice(prefix.length));
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, entry.data());
    chmodSync(output, entry.mode);
  }
}

export function runNative(args: string[], env: Record<string, string | undefined>, stdin?: string) {
  const result = Bun.spawnSync(args, {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = result.stdout.toString() + result.stderr.toString();
  assert.equal(result.exitCode, 0, `${args[0]} failed: ${output}`);
  assert(!output.includes('ERROR:') && !output.includes('FATAL:'), output);
  return output;
}

export async function prepareNativeCarrierSdk({
  root,
  runtimeFile,
  npmFiles,
  runtimeVersion,
  selected,
}: {
  root: string;
  runtimeFile: string;
  npmFiles: string[];
  runtimeVersion: string;
  selected: string[];
}) {
  const sdk = path.join(root, 'node_modules/@oliphaunt/ts');
  cpSync(path.resolve(import.meta.dirname, '../../src/native/sdks/ts'), sdk, { recursive: true });
  writableDirectories(sdk);
  const packages = npmFiles.map((file) => {
    const entries = readPortableArchiveEntries(realpathSync(file));
    const manifest = JSON.parse(entries.get('package/package.json')!.data().toString('utf8'));
    const directory = path.join(root, 'node_modules', manifest.name);
    extractNativeArchive(file, directory, 'package/');
    return { manifest, directory };
  });
  const runtime = path.join(root, 'host');
  mkdirSync(runtime, { recursive: true });
  runNative(['tar', '-xf', realpathSync(runtimeFile), '-C', runtime], {});
  const library = path.join(runtime, 'lib/liboliphaunt.so');
  const ffi = dlopen(library, { oliphaunt_version: { args: [], returns: 'ptr' } });
  try {
    assert.equal(
      new CString(ffi.symbols.oliphaunt_version()).toString(),
      runtimeVersion,
      'actual incorporated supplier identity differs from extension host pin',
    );
  } finally {
    ffi.close();
  }
  const sdkManifestFile = path.join(sdk, 'package.json');
  const sdkManifestBytes = readFileSync(sdkManifestFile);
  const sdkManifest = JSON.parse(sdkManifestBytes.toString('utf8'));
  const sdkRuntimeVersion = sdkManifest.oliphaunt.liboliphauntVersion;
  const assets = await import(pathToFileURL(path.join(sdk, 'src/native/assets.ts')).href);
  const install = { libraryPath: library, runtimeDirectory: runtime };
  if (sdkRuntimeVersion !== runtimeVersion) {
    await assert.rejects(
      () => assets.materializeExtensionInstall(install, selected),
      /does not match @oliphaunt\/ts liboliphauntVersion/,
      'source SDK must reject a carrier outside its unchanged declared host requirement',
    );
    console.log(
      `Source SDK host ${sdkRuntimeVersion} rejects extension host ${runtimeVersion}; constructor SQL uses the explicit runtime-directory API. Default adoption requires the generated SDK and frozen installed consumers.`,
    );
  }
  const extensionRuntime = await import(
    pathToFileURL(path.join(sdk, 'src/native/extension-runtime.ts')).href
  );
  const materialize = async (extensions: string[]) => {
    assert.deepEqual(readFileSync(sdkManifestFile), sdkManifestBytes, 'SDK manifest was altered');
    if (sdkRuntimeVersion === runtimeVersion)
      return assets.materializeExtensionInstall(install, extensions);
    // A producer can change before release preparation adopts its exact host in
    // an independently versioned SDK. Qualify those real bytes through the
    // supported explicit-runtime API without changing any SDK requirements.
    const selected = extensionRuntime.selectedExtensionClosure(extensions) as string[];
    const stage = mkdtempSync(path.join(tmpdir(), 'native-explicit-extension-'));
    const runtimeDirectory = path.join(stage, 'runtime');
    try {
      cpSync(runtime, runtimeDirectory, { recursive: true });
      for (const sqlName of selected) {
        const owners = packages.filter(({ manifest }) =>
          manifest.oliphaunt.members.includes(sqlName),
        );
        assert.equal(
          owners.length,
          1,
          `selected extension ${sqlName} has no unique installed carrier`,
        );
        const { manifest, directory } = owners[0];
        const relative =
          manifest.oliphaunt.memberRuntimeRelativePaths?.[sqlName] ??
          manifest.oliphaunt.runtimeRelativePath;
        assert.equal(
          typeof relative,
          'string',
          `selected extension ${sqlName} has no runtime payload`,
        );
        cpSync(assets.resolvePackageRelativePath(directory, relative, sqlName), runtimeDirectory, {
          recursive: true,
        });
      }
      const prepared = await assets.prepareExtensionInstall(
        { ...install, runtimeDirectory, packageManaged: false },
        extensions,
        { explicitRuntimeDirectory: true },
      );
      assert.deepEqual(readFileSync(sdkManifestFile), sdkManifestBytes, 'SDK manifest was altered');
      return prepared;
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  };
  return { assets, install, runtime, packages, materialize, sdkRuntimeVersion };
}

export function exerciseNativeCarrierSql({
  root,
  runtime,
  materialized,
  consumerFile,
  plans,
  environment = [],
}: {
  root: string;
  runtime: string;
  materialized: { runtimeDirectory: string; moduleDirectory: string };
  consumerFile: string;
  plans: string[];
  environment?: { name: string; path: string }[];
}) {
  const [installSql, smokeSql, startupFile] = plans;
  const consumer = path.join(root, 'consumer');
  cpSync(realpathSync(consumerFile), consumer);
  chmodSync(consumer, 0o755);
  const env: Record<string, string | undefined> = {
    LD_LIBRARY_PATH: path.join(runtime, 'lib'),
    OLIPHAUNT_SMOKE_MODULE_DIR: materialized.moduleDirectory,
    OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY: '1',
    OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY: '1',
  };
  for (const row of environment) env[row.name] = path.join(materialized.runtimeDirectory, row.path);
  const initialize = (database: string) => {
    mkdirSync(database, { recursive: true });
    runNative(
      [
        path.join(runtime, 'bin/initdb'),
        '-D',
        path.join(database, 'pgdata'),
        '-U',
        'postgres',
        '--auth=trust',
        '--no-sync',
        '--locale-provider=libc',
        '--locale=C',
        '--encoding=UTF8',
      ],
      env,
    );
    writeFileSync(
      path.join(database, '.oliphaunt.json'),
      JSON.stringify({
        schema: 'oliphaunt-database-root-v1',
        engineFamily: 'native',
        pgdata: 'pgdata',
        postgresMajor: 18,
        physicalFormat: 'native-pg18-v1',
      }),
    );
  };
  const embedded = path.join(root, 'embedded');
  initialize(embedded);
  for (let restart = 0; restart < 2; restart++)
    runNative(
      [
        consumer,
        path.join(embedded, 'pgdata'),
        materialized.runtimeDirectory,
        '--sql-plan',
        realpathSync(installSql),
        realpathSync(smokeSql),
        realpathSync(startupFile),
      ],
      env,
    );
  const server = path.join(root, 'server');
  initialize(server);
  const sql = [installSql, smokeSql]
    .map((file) => readFileSync(file, 'utf8').replace(/^-- oliphaunt-statement$/gmu, ''))
    .join('\n');
  const startup = readFileSync(startupFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((assignment) => ['-c', assignment]);
  const output = runNative(
    [
      path.join(materialized.runtimeDirectory, 'bin/postgres'),
      '--single',
      '-j',
      '-D',
      path.join(server, 'pgdata'),
      ...startup,
      'postgres',
    ],
    env,
    sql,
  );
  assert(output.includes('candidate-extension-smoke-ok'));
}
