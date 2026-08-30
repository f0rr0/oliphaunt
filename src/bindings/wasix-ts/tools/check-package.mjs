import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

import {
  prepareWasixTypescriptPackage,
  WASIX_TYPESCRIPT_REQUIRED_PACKAGE_FILES,
} from '../../../../tools/release/wasix-typescript-package.mjs';
import { loadHostBuildContract } from '../host/build-provenance.mjs';

const execFileAsync = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
const runtimePackage = '@oliphaunt/liboliphaunt-wasix';
const benchmarkComparisonPackage = '@electric-sql/pglite';
const fzstdPackage = 'fzstd';
const fzstdVersion = '0.1.1';
const nativePackages = Object.freeze([
  '@oliphaunt/wasix-napi-darwin-arm64',
  '@oliphaunt/wasix-napi-linux-arm64-gnu',
  '@oliphaunt/wasix-napi-linux-x64-gnu',
  '@oliphaunt/wasix-napi-win32-x64-msvc',
]);
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
  const packOutput = resolve(scratch, 'pack.json');
  await writePnpmPackInventory(staging, packOutput);
  const result = JSON.parse(await readFile(packOutput, 'utf8'));
  const packed = Array.isArray(result) ? result[0] : result;
  const paths = new Set(packed.files?.map((entry) => entry.path));
  // Release Please owns the first changelog entry, so an unreleased 0.0.0
  // source package deliberately carries an empty CHANGELOG.md. Keep the
  // released archive contract strict while allowing that one pre-release
  // dry-run entry to remain empty or be omitted by the pack implementation.
  const dryRunRequiredPaths = WASIX_TYPESCRIPT_REQUIRED_PACKAGE_FILES.filter(
    (path) => path !== 'CHANGELOG.md' || stagedPackageJson.version !== '0.0.0',
  );
  const expectedPaths = new Set(WASIX_TYPESCRIPT_REQUIRED_PACKAGE_FILES);

  for (const path of dryRunRequiredPaths) {
    if (!paths.has(path)) {
      throw new Error(`WASIX TypeScript package dry-run omitted ${path}`);
    }
  }
  const unexpectedPaths = [...paths].filter((path) => !expectedPaths.has(path)).sort();
  if (unexpectedPaths.length > 0) {
    throw new Error(
      `WASIX TypeScript package dry-run contained files outside the explicit inventory: ${unexpectedPaths.join(', ')}`,
    );
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
    './direct',
    './worker',
    './package.json',
    './internal/tools',
    './server',
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
  const direct = exports['./direct'];
  if (
    JSON.stringify(Object.keys(direct ?? {})) !==
      JSON.stringify(['types', 'deno', 'bun', 'node']) ||
    direct?.types !== './lib/direct.node.d.ts' ||
    direct?.deno !== './lib/direct.node.js' ||
    direct?.bun !== './lib/direct.node.js' ||
    direct?.node !== './lib/direct.node.js'
  ) {
    throw new Error(
      'WASIX TypeScript package omitted its exact host-only conditional direct entrypoint',
    );
  }
  const internalTools = exports['./internal/tools'];
  if (
    internalTools?.types !== './lib/internal.d.ts' ||
    internalTools?.deno !== './lib/internal.node.js' ||
    internalTools?.bun !== './lib/internal.node.js' ||
    internalTools?.node !== './lib/internal.node.js' ||
    internalTools?.browser !== './lib/internal.js' ||
    internalTools?.default !== './lib/internal.js'
  ) {
    throw new Error('WASIX TypeScript package omitted its version-locked tools bridge');
  }
  const server = exports['./server'];
  if (
    JSON.stringify(Object.keys(server ?? {})) !==
      JSON.stringify(['types', 'deno', 'bun', 'node']) ||
    server?.types !== './lib/server.node.d.ts' ||
    server?.deno !== './lib/server.node.js' ||
    server?.bun !== './lib/server.node.js' ||
    server?.node !== './lib/server.node.js'
  ) {
    throw new Error(
      'WASIX TypeScript package omitted its exact host-only conditional server entrypoint',
    );
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
      'WASIX TypeScript package omitted its exact browser/Node/Bun/Deno/Electron conditional facade',
    );
  }
  const workerExport = exports['./worker'];
  if (
    JSON.stringify(Object.keys(workerExport ?? {})) !==
      JSON.stringify(['types', 'deno', 'bun', 'node', 'browser', 'default']) ||
    workerExport?.types !== './lib/worker-entry.d.ts' ||
    workerExport?.deno !== './lib/worker-entry.deno.js' ||
    workerExport?.bun !== './lib/worker-entry.bun.js' ||
    workerExport?.browser !== './lib/worker-entry.js' ||
    workerExport?.node !== './lib/worker-entry.node.js' ||
    workerExport?.default !== './lib/worker-entry.js'
  ) {
    throw new Error(
      'WASIX TypeScript package omitted its exact browser/Node/Bun/Deno/Electron Worker facade',
    );
  }

  if (
    packageJson.dependencies?.[runtimePackage] !== undefined ||
    packageJson.dependencies?.[fzstdPackage] !== fzstdVersion ||
    JSON.stringify(Object.keys(packageJson.dependencies ?? {}).sort()) !==
      JSON.stringify([fzstdPackage]) ||
    JSON.stringify(Object.keys(packageJson.optionalDependencies ?? {}).sort()) !==
      JSON.stringify([...nativePackages].sort()) ||
    nativePackages.some(
      (name) => packageJson.optionalDependencies?.[name] !== 'workspace:*',
    ) ||
    packageJson.dependencies?.[benchmarkComparisonPackage] !== undefined ||
    packageJson.dependencies?.['@wasmer/sdk'] !== undefined ||
    packageJson.dependencies?.['@oliphaunt/ts'] !== undefined ||
    packageJson.oliphaunt?.wasixNapiProduct !== 'oliphaunt-wasix-napi' ||
    !/^\d+\.\d+\.\d+$/.test(packageJson.oliphaunt?.wasixNapiVersion ?? '') ||
    packageJson.oliphaunt?.wasixAddonAbiVersion !== 1 ||
    packageJson.oliphaunt?.nodeApiVersion !== 8 ||
    packageJson.oliphaunt?.browserHost !== 'wasmer-js-patched' ||
    packageJson.oliphaunt?.serverHost !== 'wasix-rust-napi'
  ) {
    throw new Error(
      'WASIX TypeScript workspace manifest must keep Wasmer browser-only and declare every native carrier',
    );
  }
  if (
    stagedPackageJson.dependencies?.[runtimePackage] !== packageJson.oliphaunt?.runtimeVersion ||
    stagedPackageJson.dependencies?.[fzstdPackage] !== fzstdVersion ||
    JSON.stringify(Object.keys(stagedPackageJson.dependencies ?? {}).sort()) !==
      JSON.stringify([fzstdPackage, runtimePackage].sort()) ||
    JSON.stringify(Object.keys(stagedPackageJson.optionalDependencies ?? {}).sort()) !==
      JSON.stringify([...nativePackages].sort()) ||
    nativePackages.some(
      (name) =>
        stagedPackageJson.optionalDependencies?.[name] !==
        packageJson.oliphaunt?.wasixNapiVersion,
    ) ||
    stagedPackageJson.dependencies?.[benchmarkComparisonPackage] !== undefined ||
    stagedPackageJson.dependencies?.['@wasmer/sdk'] !== undefined ||
    stagedPackageJson.dependencies?.['@oliphaunt/ts'] !== undefined
  ) {
    throw new Error(
      'WASIX TypeScript release package does not own exact browser and native runtime closures',
    );
  }

  const provenance = JSON.parse(
    await readFile(resolve(packageDir, 'lib/host/provenance.json'), 'utf8'),
  );
  if (!isDeepStrictEqual(provenance, expectedHostBuild)) {
    throw new Error('WASIX TypeScript package omitted patched-host provenance');
  }

  const browserClient = await readFile(resolve(packageDir, 'lib/client.js'), 'utf8');
  const browserWorker = await readFile(resolve(packageDir, 'lib/worker.js'), 'utf8');
  const nodeDirect = await readFile(resolve(packageDir, 'lib/node-direct.js'), 'utf8');
  const nodeActor = await readFile(resolve(packageDir, 'lib/node-actor.js'), 'utf8');
  const nodeWorker = await readFile(resolve(packageDir, 'lib/node-worker.js'), 'utf8');
  const nodeIsolatedClient = await readFile(
    resolve(packageDir, 'lib/worker-node-client.js'),
    'utf8',
  );
  const nodeServer = await readFile(resolve(packageDir, 'lib/server.node.js'), 'utf8');
  if (
    !browserClient.includes("import('./host/index.mjs')") ||
    !browserWorker.includes("from './host/index.mjs'") ||
    !nodeDirect.includes("from './native-session.js'") ||
    !nodeActor.includes("from './native-session.js'") ||
    !nodeWorker.includes("from './node-direct.js'") ||
    !nodeIsolatedClient.includes("from 'node:worker_threads'") ||
    !nodeIsolatedClient.includes("new URL('./node-worker.js', import.meta.url)") ||
    !nodeServer.includes("from './native-server.js'") ||
    nodeDirect.includes("from './node-host.js'") ||
    nodeActor.includes("from './node-host.js'") ||
    nodeWorker.includes("from './node-host.js'") ||
    nodeIsolatedClient.includes("from 'node:child_process'") ||
    nodeServer.includes("from './node-host.js'")
  ) {
    throw new Error('WASIX TypeScript package did not preserve its browser-Wasmer/native split');
  }

  await assertMissingNativeCarrierFailsClosed(staging);

  console.log(`wasix-ts package-shape: PASS ${packed.filename}`);
} finally {
  await rm(scratch, { force: true, recursive: true });
}

async function assertMissingNativeCarrierFailsClosed(staging) {
  const environment = { ...process.env };
  delete environment.OLIPHAUNT_WASIX_NAPI;
  const source = String.raw`
    const { loadNativeWasixAddon } = await import('./lib/native-addon.js');
    try {
      loadNativeWasixAddon();
      throw new Error('native addon unexpectedly loaded without a platform carrier');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes('is not installed; reinstall @oliphaunt/wasix-ts with optional dependencies enabled') &&
        !message.startsWith('no Oliphaunt WASIX Node-API package is defined for ')
      ) {
        throw error;
      }
      if (/Wasmer|WebAssembly/i.test(message)) {
        throw new Error('missing native carrier attempted a Wasmer fallback');
      }
    }
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: staging,
    env: environment,
  });
}

async function writePnpmPackInventory(cwd, outputPath) {
  // pnpm 11 emits no dry-run JSON when stdout is a pipe. Give it a regular
  // scratch file, then parse that exact output above.
  const output = await open(outputPath, 'wx');
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn('pnpm', ['pack', '--dry-run', '--json'], {
        cwd,
        env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: 'true' },
        stdio: ['ignore', output.fd, 'inherit'],
      });
      child.once('error', rejectRun);
      child.once('close', (code, signal) => {
        if (code === 0) {
          resolveRun();
          return;
        }
        rejectRun(
          new Error(
            signal === null
              ? `pnpm pack --dry-run exited with status ${code}`
              : `pnpm pack --dry-run ended with signal ${signal}`,
          ),
        );
      });
    });
  } finally {
    await output.close();
  }
}
