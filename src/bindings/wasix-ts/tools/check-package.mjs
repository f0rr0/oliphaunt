import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { prepareWasixTypescriptPackage } from '../../../../tools/release/wasix-typescript-package.mjs';

const execFileAsync = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
const runtimePackage = '@oliphaunt/liboliphaunt-wasix';

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
    'lib/index.node.js',
    'lib/node-client.js',
    'lib/node-worker.js',
    'lib/node-web-worker.js',
    'lib/node-web-worker-thread.js',
    'lib/worker.js',
    'lib/host/index.mjs',
    'lib/host/index.d.mts',
    'lib/host/worker.mjs',
    'lib/host/wasmer_js_bg.wasm',
    'lib/host/provenance.json',
    'lib/host/LICENSE',
    'lib/storage/indexed-db.js',
    'lib/storage/indexed-db.d.ts',
  ]) {
    if (!paths.has(path)) {
      throw new Error(`WASIX TypeScript package dry-run omitted ${path}`);
    }
  }

  if (
    packageJson.private === true ||
    !/^\d+\.\d+\.\d+$/.test(packageJson.version) ||
    packageJson.version === '0.0.0' ||
    packageJson.publishConfig?.access !== 'public' ||
    packageJson.publishConfig?.provenance !== true
  ) {
    throw new Error('WASIX TypeScript package-shape must be a versioned public npm package');
  }
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (Object.hasOwn(packageJson.scripts ?? {}, lifecycle)) {
      throw new Error(`WASIX TypeScript package must not run consumer ${lifecycle} lifecycle`);
    }
  }

  const exports = packageJson.exports ?? {};
  const expectedExports = ['.', './package.json', './protocol', './query', './storage/indexed-db'];
  if (JSON.stringify(Object.keys(exports).sort()) !== JSON.stringify(expectedExports.sort())) {
    throw new Error('WASIX TypeScript package exports do not match its clean public surface');
  }
  if (exports['./storage/indexed-db'] === undefined) {
    throw new Error('WASIX TypeScript package omitted the selective IndexedDB entrypoint');
  }
  if (exports['./storage/opfs'] !== undefined || exports['./storage/node'] !== undefined) {
    throw new Error('WASIX TypeScript package exposes an unimplemented storage adapter');
  }
  const rootExport = exports['.'];
  if (
    rootExport?.types !== './lib/index.d.ts' ||
    rootExport?.browser !== './lib/index.js' ||
    rootExport?.node !== './lib/index.node.js' ||
    rootExport?.default !== './lib/index.js'
  ) {
    throw new Error('WASIX TypeScript package omitted its exact browser/Node conditional facade');
  }

  if (
    packageJson.dependencies?.[runtimePackage] !== undefined ||
    packageJson.dependencies?.['@wasmer/sdk'] !== undefined ||
    packageJson.dependencies?.['@oliphaunt/ts'] !== undefined
  ) {
    throw new Error(
      'WASIX TypeScript workspace manifest must not resolve generated or native hosts',
    );
  }
  if (
    stagedPackageJson.dependencies?.[runtimePackage] !== packageJson.oliphaunt?.runtimeVersion ||
    stagedPackageJson.dependencies?.['@wasmer/sdk'] !== undefined ||
    stagedPackageJson.dependencies?.['@oliphaunt/ts'] !== undefined
  ) {
    throw new Error('WASIX TypeScript release package does not own an exact portable-only closure');
  }

  const provenance = JSON.parse(
    await readFile(resolve(packageDir, 'lib/host/provenance.json'), 'utf8'),
  );
  if (
    typeof provenance.wasmerJsVersion !== 'string' ||
    typeof provenance.wasmerJsCommit !== 'string' ||
    !/^[a-f0-9]{64}$/.test(provenance.packageLockSha256 ?? '') ||
    typeof provenance.inputsSha256 !== 'string'
  ) {
    throw new Error('WASIX TypeScript package omitted patched-host provenance');
  }

  console.log(`wasix-ts package-shape: PASS ${packed.filename}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}
