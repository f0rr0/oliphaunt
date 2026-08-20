import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

import { prepareWasixTypescriptPackage } from '../../../../tools/release/wasix-typescript-package.mjs';
import { loadHostBuildContract } from '../host/build-provenance.mjs';

const execFileAsync = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
const runtimePackage = '@oliphaunt/liboliphaunt-wasix';
const benchmarkComparisonPackage = '@electric-sql/pglite';
const fzstdPackage = 'fzstd';
const fzstdVersion = '0.1.1';
const expectedHostBuild = (await loadHostBuildContract()).provenance;

await execFileAsync('pnpm', ['run', 'package:build'], {
  cwd: packageDir,
  env: process.env,
  maxBuffer: 16 * 1024 * 1024,
});

const scratch = await mkdtemp(resolve(tmpdir(), 'oliphaunt-wasix-package-check-'));
try {
  const staging = resolve(scratch, 'package');
  await mkdir(staging);
  for (const name of ['package.json', 'README.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'lib']) {
    await cp(resolve(packageDir, name), resolve(staging, name), { recursive: true });
  }
  const stagedPackageJson = prepareWasixTypescriptPackage(staging);
  const { stdout } = await execFileAsync('pnpm', ['pack', '--dry-run', '--json'], {
    cwd: staging,
    env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: 'true' },
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  const packed = Array.isArray(result) ? result[0] : result;
  const paths = new Set(packed.files?.map((entry) => entry.path));

  for (const path of [
    'package.json',
    'README.md',
    'ARCHITECTURE.md',
    'CHANGELOG.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'lib/index.js',
    'lib/index.d.ts',
    'lib/index.bun.js',
    'lib/index.deno.js',
    'lib/index.node.js',
    'lib/protocol.js',
    'lib/protocol.d.ts',
    'lib/query.js',
    'lib/query.d.ts',
    'lib/node-client.js',
    'lib/node-direct.js',
    'lib/node-directory-lock.js',
    'lib/node-worker.js',
    'lib/node-worker-options.js',
    'lib/node-zstd.js',
    'lib/host-runtime.js',
    'lib/worker.js',
    'lib/host/index.mjs',
    'lib/host/index.d.mts',
    'lib/host/worker.mjs',
    'lib/host/wasmer_js_bg.wasm',
    'lib/host/provenance.json',
    'lib/host/LICENSE',
    'lib/node-fs-commit-state.js',
    'lib/storage/indexed-db.js',
    'lib/storage/indexed-db.d.ts',
    'lib/storage/incremental-storage.js',
    'lib/storage/opfs.js',
    'lib/storage/opfs.d.ts',
    'lib/storage/opfs-provider.js',
    'lib/storage/web-lock.js',
    'lib/storage/bun.js',
    'lib/storage/bun.d.ts',
    'lib/storage/deno.js',
    'lib/storage/deno.d.ts',
    'lib/storage/node.js',
    'lib/storage/node.d.ts',
    'lib/storage/node-directory-provider.js',
    'lib/zstd.js',
  ]) {
    if (!paths.has(path)) {
      throw new Error(`WASIX TypeScript package dry-run omitted ${path}`);
    }
  }
  for (const removed of ['lib/node-lock-identity.js', 'lib/node-lock-identity.d.ts']) {
    if (paths.has(removed)) {
      throw new Error(`WASIX TypeScript package dry-run retained deleted output ${removed}`);
    }
  }

  // New products intentionally remain at 0.0.0 until Release Please creates
  // the first release candidate; publication still requires that transition.
  if (
    packageJson.name !== '@oliphaunt/wasix-ts' ||
    packageJson.private === true ||
    !/^\d+\.\d+\.\d+$/.test(packageJson.version) ||
    packageJson.publishConfig?.access !== 'public' ||
    packageJson.publishConfig?.provenance !== true
  ) {
    throw new Error('WASIX TypeScript package-shape must be a stable-version public npm package');
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (Object.hasOwn(packageJson.scripts ?? {}, lifecycle)) {
      throw new Error(`WASIX TypeScript package must not run consumer ${lifecycle} lifecycle`);
    }
  }

  const exports = packageJson.exports ?? {};
  const expectedExports = [
    '.',
    './package.json',
    './protocol',
    './query',
    './storage/bun',
    './storage/deno',
    './storage/indexed-db',
    './storage/node',
    './storage/opfs',
  ];
  if (JSON.stringify(Object.keys(exports).sort()) !== JSON.stringify(expectedExports.sort())) {
    throw new Error('WASIX TypeScript package exports do not match its clean public surface');
  }
  if (exports['./storage/indexed-db'] === undefined) {
    throw new Error('WASIX TypeScript package omitted the selective IndexedDB entrypoint');
  }
  for (const name of ['protocol', 'query']) {
    const entry = exports[`./${name}`];
    if (
      JSON.stringify(Object.keys(entry ?? {})) !== JSON.stringify(['types', 'default']) ||
      entry?.types !== `./lib/${name}.d.ts` ||
      entry?.default !== `./lib/${name}.js`
    ) {
      throw new Error(`WASIX TypeScript package ${name} subpath is not exact`);
    }
  }
  if (
    exports['./storage/node']?.types !== './lib/storage/node.d.ts' ||
    exports['./storage/node']?.node !== './lib/storage/node.js' ||
    exports['./storage/node']?.browser !== undefined ||
    exports['./storage/node']?.default !== undefined
  ) {
    throw new Error('WASIX TypeScript package omitted its Node-only directory adapter');
  }
  if (
    exports['./storage/bun']?.types !== './lib/storage/bun.d.ts' ||
    exports['./storage/bun']?.bun !== './lib/storage/bun.js' ||
    Object.keys(exports['./storage/bun'] ?? {}).some(
      (condition) => !['types', 'bun'].includes(condition),
    )
  ) {
    throw new Error('WASIX TypeScript package omitted its Bun-only directory adapter');
  }
  if (
    exports['./storage/deno']?.types !== './lib/storage/deno.d.ts' ||
    exports['./storage/deno']?.deno !== './lib/storage/deno.js' ||
    Object.keys(exports['./storage/deno'] ?? {}).some(
      (condition) => !['types', 'deno'].includes(condition),
    )
  ) {
    throw new Error('WASIX TypeScript package omitted its Deno-only directory adapter');
  }
  if (
    exports['./storage/opfs']?.types !== './lib/storage/opfs.d.ts' ||
    exports['./storage/opfs']?.default !== './lib/storage/opfs.js' ||
    Object.keys(exports['./storage/opfs'] ?? {}).some(
      (condition) => !['types', 'default'].includes(condition),
    )
  ) {
    throw new Error('WASIX TypeScript package omitted its selective OPFS adapter');
  }
  const rootExport = exports['.'];
  if (
    JSON.stringify(Object.keys(rootExport ?? {})) !==
      JSON.stringify(['types', 'deno', 'bun', 'node', 'browser', 'default']) ||
    rootExport?.types !== './lib/index.d.ts' ||
    rootExport?.deno !== './lib/index.deno.js' ||
    rootExport?.bun !== './lib/index.bun.js' ||
    rootExport?.browser !== './lib/index.js' ||
    rootExport?.node !== './lib/index.node.js' ||
    rootExport?.default !== './lib/index.js'
  ) {
    throw new Error(
      'WASIX TypeScript package omitted its exact browser/Node/Bun/Deno conditional facade',
    );
  }

  if (
    packageJson.dependencies?.[runtimePackage] !== undefined ||
    packageJson.dependencies?.[fzstdPackage] !== fzstdVersion ||
    packageJson.dependencies?.[benchmarkComparisonPackage] !== undefined ||
    packageJson.dependencies?.['@wasmer/sdk'] !== undefined ||
    packageJson.dependencies?.['@oliphaunt/ts'] !== undefined
  ) {
    throw new Error(
      'WASIX TypeScript workspace manifest must not resolve generated or native hosts',
    );
  }
  if (
    stagedPackageJson.dependencies?.[runtimePackage] !== packageJson.oliphaunt?.runtimeVersion ||
    stagedPackageJson.dependencies?.[fzstdPackage] !== fzstdVersion ||
    stagedPackageJson.dependencies?.[benchmarkComparisonPackage] !== undefined ||
    stagedPackageJson.dependencies?.['@wasmer/sdk'] !== undefined ||
    stagedPackageJson.dependencies?.['@oliphaunt/ts'] !== undefined
  ) {
    throw new Error('WASIX TypeScript release package does not own an exact portable-only closure');
  }

  const provenance = JSON.parse(
    await readFile(resolve(packageDir, 'lib/host/provenance.json'), 'utf8'),
  );
  if (!isDeepStrictEqual(provenance, expectedHostBuild)) {
    throw new Error('WASIX TypeScript package omitted patched-host provenance');
  }

  console.log(`wasix-ts package-shape: PASS ${packed.filename}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}
