import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { prepareWasixTypescriptPackage } from '../../../../tools/release/wasix-typescript-package.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../../..');
const assetRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix/assets');
const releaseVersions = JSON.parse(
  await readFile(resolve(repositoryRoot, '.release-please-manifest.json'), 'utf8'),
);
const runtimeVersion = releaseVersions['src/runtimes/liboliphaunt/wasix'];
const extensionVersion = releaseVersions['src/extensions/external/pgtap'];
const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-node-smoke-'));

try {
  const tarballs = resolve(scratch, 'tarballs');
  await mkdir(tarballs);
  const binding = await packBinding(tarballs);
  const runtime = await packRuntime(tarballs);
  const extension = await packPgtap(tarballs);
  const consumer = resolve(scratch, 'consumer');
  await mkdir(consumer);
  await writeJson(resolve(consumer, 'package.json'), {
    name: 'oliphaunt-wasix-node-smoke-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@oliphaunt/extension-pgtap-wasix': `file:${extension}`,
      '@oliphaunt/liboliphaunt-wasix': `file:${runtime}`,
      '@oliphaunt/wasix': `file:${binding}`,
    },
  });
  await writeFile(
    resolve(consumer, 'pnpm-workspace.yaml'),
    `packages:\n  - .\noverrides:\n  '@oliphaunt/liboliphaunt-wasix': file:${runtime}\n`,
  );
  await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer);
  await writeFile(
    resolve(consumer, 'verify.mjs'),
    `import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt, { PostgresError } from '@oliphaunt/wasix';

const resolved = import.meta.resolve('@oliphaunt/wasix');
if (!resolved.endsWith('/lib/index.node.js')) {
  throw new Error('Node did not select the worker_threads entrypoint: ' + resolved);
}
const db = await Oliphaunt.open({ extensions: [pgtap] });
const version = (await db.query('SELECT pgtap_version()::text AS version')).getText(0, 'version');
let sqlstate;
try {
  await db.query('SELEC 1');
} catch (error) {
  if (!(error instanceof PostgresError)) throw error;
  sqlstate = error.sqlstate;
}
const answer = (await db.query('SELECT 42::int AS answer')).getText(0, 'answer');
await db.close();
if (!version || sqlstate !== '42601' || answer !== '42') {
  throw new Error(JSON.stringify({ version, sqlstate, answer }));
}
console.log(JSON.stringify({ host: 'node-worker_threads', extension: 'pgtap', version, sqlstate, answer }));
`,
  );
  const { stdout } = await run(process.execPath, ['verify.mjs'], consumer, 300_000);
  console.log(`wasix-ts Node smoke: PASS ${stdout.trim()}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}

async function packBinding(tarballs) {
  const staging = resolve(scratch, 'binding');
  await mkdir(staging);
  for (const name of ['package.json', 'README.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'lib']) {
    await cp(resolve(packageRoot, name), resolve(staging, name), { recursive: true });
  }
  prepareWasixTypescriptPackage(staging);
  return pack(staging, tarballs);
}

async function packRuntime(tarballs) {
  const staging = resolve(scratch, 'runtime');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'));
  const coreManifest = Buffer.from(JSON.stringify({ ...manifest, extensions: [] }));
  const runtimeSource = resolve(assetRoot, manifest.runtime.archive);
  const pgdataSource = resolve(assetRoot, manifest['pgdata-template'].archive);
  const runtimeBytes = await readFile(runtimeSource);
  const pgdataBytes = await readFile(pgdataSource);
  await cp(runtimeSource, resolve(assets, 'runtime.tar.zst'));
  await cp(pgdataSource, resolve(assets, 'pgdata.tar.zst'));
  await writeFile(resolve(assets, 'manifest.json'), coreManifest);
  const descriptor = {
    schema: 'oliphaunt-wasix-runtime-v1',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: runtimeVersion,
    runtimeArchive: {
      archive: manifest.runtime.archive,
      sha256: sha256(runtimeBytes),
      size: runtimeBytes.length,
    },
    pgdataArchive: {
      archive: manifest['pgdata-template'].archive,
      sha256: sha256(pgdataBytes),
      size: pgdataBytes.length,
    },
    manifest: { sha256: sha256(coreManifest), size: coreManifest.length },
  };
  await writeFile(
    resolve(staging, 'index.js'),
    `const descriptor = ${JSON.stringify(descriptor, null, 2)};
descriptor.runtimeArchive.source = new URL('./assets/runtime.tar.zst', import.meta.url);
descriptor.pgdataArchive.source = new URL('./assets/pgdata.tar.zst', import.meta.url);
descriptor.manifest.source = new URL('./assets/manifest.json', import.meta.url);
export default Object.freeze(descriptor);
`,
  );
  await writeJson(resolve(staging, 'package.json'), {
    name: '@oliphaunt/liboliphaunt-wasix',
    version: runtimeVersion,
    type: 'module',
    exports: { '.': './index.js' },
  });
  return pack(staging, tarballs);
}

async function packPgtap(tarballs) {
  const staging = resolve(scratch, 'pgtap');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'));
  const row = manifest.extensions.find((candidate) => candidate['sql-name'] === 'pgtap');
  if (row === undefined) throw new Error('WASIX manifest has no pgtap carrier');
  await cp(resolve(assetRoot, row.archive), resolve(assets, 'pgtap.tar.zst'));
  const lifecycle = row.lifecycle;
  const carrier = {
    product: 'oliphaunt-extension-pgtap',
    version: extensionVersion,
    sqlName: 'pgtap',
    archive: row.archive,
    sha256: row.sha256,
    size: row.size,
    install: {
      schema: 'oliphaunt-wasix-extension-install-v1',
      name: row.name,
      nativeModule: null,
      nativeModules: [],
      dependencies: row.dependencies,
      coreExportsRequired: row['core-exports-required'],
      loadOrder: row['load-order'],
      lifecycle: {
        createExtension: lifecycle['create-extension'],
        createSchema: lifecycle['create-schema'],
        loadSql: lifecycle['load-sql'],
        postCreateSql: lifecycle['post-create-sql'],
        startupConfig: lifecycle['startup-config'],
        preloadRequired: lifecycle['preload-required'],
        restartRequired: lifecycle['restart-required'],
        sharedMemoryRequired: lifecycle['shared-memory-required'],
      },
      installedFiles: row['installed-files'],
      unresolvedImports: row['unresolved-imports'],
    },
  };
  const descriptor = {
    schema: 'oliphaunt-wasix-extension-v1',
    runtime: 'wasix',
    product: carrier.product,
    version: carrier.version,
    compatibility: {
      extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
      postgresMajor: '18',
      wasixRuntimeProduct: 'liboliphaunt-wasix',
      wasixRuntimeVersion: runtimeVersion,
    },
    sqlName: 'pgtap',
    carriers: [carrier],
  };
  await writeFile(
    resolve(staging, 'index.js'),
    `const descriptor = ${JSON.stringify(descriptor, null, 2)};
descriptor.carriers[0].source = new URL('./assets/pgtap.tar.zst', import.meta.url);
export default descriptor;
`,
  );
  await writeJson(resolve(staging, 'package.json'), {
    name: '@oliphaunt/extension-pgtap-wasix',
    version: extensionVersion,
    type: 'module',
    exports: { '.': './index.js' },
  });
  return pack(staging, tarballs);
}

async function pack(directory, tarballs) {
  const { stdout } = await run(
    'pnpm',
    ['pack', '--pack-destination', tarballs, '--json'],
    directory,
  );
  const result = JSON.parse(stdout);
  const filename = Array.isArray(result) ? result[0]?.filename : result.filename;
  if (typeof filename !== 'string') throw new Error(`pnpm pack returned ${stdout}`);
  return resolve(directory, filename);
}

async function run(command, args, cwd, timeout = 120_000) {
  return execFileAsync(command, args, {
    cwd,
    env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: 'true' },
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
