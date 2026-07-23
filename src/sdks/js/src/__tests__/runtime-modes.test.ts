import assert from 'node:assert/strict';
import { test } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

import type { NormalizedOpenConfig } from '../config.js';
import {
  brokerCapabilities,
  brokerModeSupport,
  createBrokerRuntimeBinding,
  restorePhysicalArchiveWithBroker,
} from '../runtime/broker.js';
import {
  canonicalPath,
  createTempDir,
  parseReadyEndpoint,
  randomHexToken,
  removeTree,
  unixSocketPathsFit,
} from '../runtime/node-adapter.js';
import {
  encodeCancelRequest,
  encodeStartupMessage,
  parseBackendKeyData,
} from '../runtime/pgwire.js';
import {
  createServerRuntimeBinding,
  nativeServerRuntimeEnv,
  serverCapabilities,
  serverConnectionString,
  serverModeSupport,
} from '../runtime/server.js';
import { readTypeScriptPackageVersions } from './package-metadata.js';

async function main(): Promise<void> {
  testBrokerCapabilities();
  testBrokerUnixSocketPathLimit();
  await testBrokerSupportAndRestoreFailureAreActionable();
  await testBrokerRestorePassesNativeInstallEnv();
  await testBrokerStartupTimeoutEnvIsValidatedBeforeNativeInstall();
  await testDenoBrokerModeRejectsPackageManagedExtensions();
  await testDenoBrokerModeValidatesExplicitExtensionRuntime();
  testServerCapabilitiesAndConnectionString();
  await testServerSupportReportsMissingExecutable();
  await testServerSupportRequiresSplitClientTools();
  await testServerStartupTimeoutEnvIsValidatedBeforeProcessSetup();
  await testServerRuntimeEnvIncludesPackagedLibraryDir();
  await testDenoServerModeRejectsPackageManagedExtensions();
  testPgwireStartupCancelAndBackendKeyFrames();
  await testNodeAdapterUtilities();
}

function testBrokerUnixSocketPathLimit(): void {
  assert.equal(unixSocketPathsFit('/tmp/lpgo-short/s', '/tmp/lpgo-short/c'), true);
  assert.equal(unixSocketPathsFit(`/tmp/${'x'.repeat(95)}/s`), false);
}

function testBrokerCapabilities(): void {
  const binding = createBrokerRuntimeBinding({ maxRoots: 4 });
  assert.equal(binding.runtime, 'node');
  assert.equal(binding.rawProtocolTransport, 'broker-ipc');
  assert.equal(binding.protocolStream, true);
  assert.deepEqual(brokerCapabilities(4), {
    engine: 'nativeBroker',
    processIsolated: true,
    multiRoot: true,
    reopenable: true,
    sameRootLogicalReopen: false,
    rootSwitchable: true,
    crashRestartable: true,
    independentSessions: false,
    maxClientSessions: 1,
    protocolRaw: true,
    protocolStream: true,
    queryCancel: true,
    backupRestore: true,
    backupFormats: ['physicalArchive'],
    restoreFormats: ['physicalArchive'],
    simpleQuery: true,
    extensions: true,
    rawProtocolTransport: 'broker-ipc',
  });
}

async function testBrokerSupportAndRestoreFailureAreActionable(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-broker-mode-'));
  const missing = join(root, 'missing-broker');
  try {
    const support = await brokerModeSupport({
      brokerExecutable: missing,
      libraryPath: join(root, 'liboliphaunt.dylib'),
      runtimeDirectory: join(root, 'runtime'),
      brokerMaxRoots: 2,
    });
    assert.equal(support.engine, 'nativeBroker');
    assert.equal(support.available, false);
    assert.equal(support.capabilities.multiRoot, true);
    assert.match(support.unavailableReason ?? '', /brokerExecutable/);

    await assert.rejects(
      async () =>
        restorePhysicalArchiveWithBroker({
          brokerExecutable: missing,
          root: join(root, 'db'),
          bytes: new Uint8Array([1, 2, 3]),
          replaceExisting: true,
        }),
      /brokerExecutable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBrokerRestorePassesNativeInstallEnv(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-broker-restore-env-'));
  const broker = join(root, process.platform === 'win32' ? 'broker.cmd' : 'broker');
  const capture = join(root, 'env.txt');
  const libraryPath = join(root, 'liboliphaunt.so');
  const runtimeDirectory = join(root, 'runtime');
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(libraryPath, '');
    if (process.platform === 'win32') {
      await writeFile(
        broker,
        `@echo off\r\n> "${capture}" echo %LIBOLIPHAUNT_PATH%\r\n>> "${capture}" echo %OLIPHAUNT_INSTALL_DIR%\r\n>> "${capture}" echo %OLIPHAUNT_RUNTIME_DIR%\r\n`,
      );
    } else {
      await writeFile(
        broker,
        `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$LIBOLIPHAUNT_PATH" "$OLIPHAUNT_INSTALL_DIR" "$OLIPHAUNT_RUNTIME_DIR" > "${capture}"\n`,
      );
    }
    await chmod(broker, 0o700);

    await restorePhysicalArchiveWithBroker({
      brokerExecutable: broker,
      root: join(root, 'db'),
      bytes: new Uint8Array([1, 2, 3]),
      libraryPath,
      runtimeDirectory,
    });

    assert.deepEqual((await readFile(capture, 'utf8')).trim().split(/\r?\n/), [
      libraryPath,
      runtimeDirectory,
      runtimeDirectory,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testBrokerStartupTimeoutEnvIsValidatedBeforeNativeInstall(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-broker-timeout-'));
  const executable = join(root, process.platform === 'win32' ? 'broker.cmd' : 'broker');
  const previous = process.env.OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS;
  try {
    await writeFile(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    await chmod(executable, 0o700);
    process.env.OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS = 'not-a-number';
    const binding = createBrokerRuntimeBinding({ executable });
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open(
            normalizedTestConfig(join(root, 'db'), {
              engine: 'nativeBroker',
            }),
          ),
        ),
      /OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS;
    } else {
      process.env.OLIPHAUNT_BROKER_STARTUP_TIMEOUT_MS = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testDenoBrokerModeRejectsPackageManagedExtensions(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-deno-broker-extension-'));
  const executable = join(root, process.platform === 'win32' ? 'broker.cmd' : 'broker');
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  try {
    await writeFile(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    await chmod(executable, 0o700);
    (globalThis as { Deno?: unknown }).Deno = {};
    const binding = createBrokerRuntimeBinding({ executable });
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open(
            normalizedTestConfig(join(root, 'db'), {
              engine: 'nativeBroker',
              extensions: ['hstore'],
            }),
          ),
        ),
      /Deno nativeBroker does not automatically materialize extension packages/,
    );
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testDenoBrokerModeValidatesExplicitExtensionRuntime(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-deno-broker-prepared-runtime-'));
  const executable = join(root, process.platform === 'win32' ? 'broker.cmd' : 'broker');
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  const { liboliphauntVersion, icuVersion } = await readTypeScriptPackageVersions();
  try {
    await writeFile(executable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    await chmod(executable, 0o700);
    (globalThis as { Deno?: unknown }).Deno = {
      build: { os: 'linux', arch: 'x86_64' },
      async readTextFile(path: string | URL) {
        const text = String(path);
        if (text.includes('@oliphaunt/icu')) {
          return JSON.stringify({
            name: '@oliphaunt/icu',
            version: icuVersion,
            oliphaunt: {
              product: 'oliphaunt-icu',
              kind: 'icu-data',
              target: 'portable',
              dataRelativePath: 'share/icu',
            },
          });
        }
        return JSON.stringify({
          name: '@oliphaunt/ts',
          oliphaunt: {
            liboliphauntVersion,
            icuPackage: '@oliphaunt/icu',
            icuVersion,
          },
        });
      },
      async stat() {
        return { isDirectory: true };
      },
      async *readDir() {
        yield { name: 'icudt76l.dat', isFile: true };
      },
    };
    const binding = createBrokerRuntimeBinding({ executable });
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open(
            normalizedTestConfig(join(root, 'db'), {
              engine: 'nativeBroker',
              extensions: ['hstore'],
              libraryPath: join(root, 'liboliphaunt.so'),
              runtimeDirectory: join(root, 'prepared-runtime'),
            }),
          ),
        ),
      /Deno nativeBroker explicit runtimeDirectory is missing hstore.control/,
    );
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function testServerCapabilitiesAndConnectionString(): void {
  const binding = createServerRuntimeBinding();
  assert.equal(binding.runtime, 'node');
  assert.equal(binding.rawProtocolTransport, 'server-wire');
  assert.equal(binding.protocolStream, true);
  assert.deepEqual(serverCapabilities(32, 'postgres://localhost/db'), {
    engine: 'nativeServer',
    processIsolated: true,
    multiRoot: false,
    reopenable: true,
    sameRootLogicalReopen: false,
    rootSwitchable: true,
    crashRestartable: false,
    independentSessions: true,
    maxClientSessions: 32,
    protocolRaw: true,
    protocolStream: true,
    queryCancel: true,
    backupRestore: true,
    backupFormats: ['sql', 'physicalArchive'],
    restoreFormats: ['physicalArchive'],
    simpleQuery: true,
    extensions: true,
    connectionString: 'postgres://localhost/db',
    rawProtocolTransport: 'server-wire',
  });
  assert.equal(
    serverConnectionString('post gres', 'app/db', 55432),
    'postgres://post%20gres@127.0.0.1:55432/app%2Fdb',
  );
}

async function testServerSupportReportsMissingExecutable(): Promise<void> {
  const support = await serverModeSupport({ serverExecutable: '/tmp/oliphaunt-missing-postgres' });
  assert.equal(support.engine, 'nativeServer');
  assert.equal(support.available, false);
  assert.equal(support.capabilities.independentSessions, true);
  assert.match(support.unavailableReason ?? '', /set serverExecutable|OLIPHAUNT_POSTGRES/);
}

async function testServerSupportRequiresSplitClientTools(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-server-tools-'));
  const bin = join(root, 'bin');
  const postgres = join(bin, process.platform === 'win32' ? 'postgres.exe' : 'postgres');
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(postgres, '');
    const missingPgDump = await serverModeSupport({ serverExecutable: postgres });
    assert.equal(missingPgDump.available, false);
    assert.match(missingPgDump.unavailableReason ?? '', /missing pg_dump/);

    await writeFile(join(bin, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'), '');
    const missingPsql = await serverModeSupport({ serverExecutable: postgres });
    assert.equal(missingPsql.available, false);
    assert.match(missingPsql.unavailableReason ?? '', /missing psql/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testServerStartupTimeoutEnvIsValidatedBeforeProcessSetup(): Promise<void> {
  const previous = process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS;
  try {
    process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS = '0';
    const binding = createServerRuntimeBinding();
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open(
            normalizedTestConfig('/tmp/oliphaunt-js-server-timeout', {
              engine: 'nativeServer',
            }),
          ),
        ),
      /OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS;
    } else {
      process.env.OLIPHAUNT_SERVER_STARTUP_TIMEOUT_MS = previous;
    }
  }
}

async function testServerRuntimeEnvIncludesPackagedLibraryDir(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'oliphaunt-js-server-env-'));
  const runtime = join(root, 'runtime');
  const toolDirectory = join(runtime, 'bin');
  const libDirectory = join(runtime, 'lib');
  const icuDirectory = join(root, 'icu');
  const envName =
    process.platform === 'darwin'
      ? 'DYLD_LIBRARY_PATH'
      : process.platform === 'win32'
        ? 'PATH'
        : 'LD_LIBRARY_PATH';
  const previous = process.env[envName];
  try {
    await mkdir(toolDirectory, { recursive: true });
    await mkdir(libDirectory, { recursive: true });
    process.env[envName] = 'existing-runtime-path';
    const env = await nativeServerRuntimeEnv(toolDirectory, icuDirectory);
    const expectedPrefix =
      process.platform === 'win32'
        ? [toolDirectory, libDirectory, 'existing-runtime-path']
        : [libDirectory, 'existing-runtime-path'];
    assert.equal(env[envName], expectedPrefix.join(delimiter));
    assert.equal(env.ICU_DATA, icuDirectory);
  } finally {
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function testDenoServerModeRejectsPackageManagedExtensions(): Promise<void> {
  const previousDeno = (globalThis as { Deno?: unknown }).Deno;
  const previousPostgres = process.env.OLIPHAUNT_POSTGRES;
  try {
    delete process.env.OLIPHAUNT_POSTGRES;
    (globalThis as { Deno?: unknown }).Deno = {};
    const binding = createServerRuntimeBinding();
    await assert.rejects(
      () =>
        Promise.resolve(
          binding.open(
            normalizedTestConfig('/tmp/oliphaunt-js-deno-server-extension', {
              engine: 'nativeServer',
              extensions: ['hstore'],
            }),
          ),
        ),
      /Deno nativeServer does not automatically materialize extension packages/,
    );
  } finally {
    if (previousDeno === undefined) {
      delete (globalThis as { Deno?: unknown }).Deno;
    } else {
      (globalThis as { Deno?: unknown }).Deno = previousDeno;
    }
    if (previousPostgres === undefined) {
      delete process.env.OLIPHAUNT_POSTGRES;
    } else {
      process.env.OLIPHAUNT_POSTGRES = previousPostgres;
    }
  }
}

function normalizedTestConfig(
  root: string,
  overrides: Partial<NormalizedOpenConfig> = {},
): NormalizedOpenConfig {
  return {
    engine: 'nativeDirect',
    root,
    pgdata: join(root, 'pgdata'),
    temporary: true,
    durability: 'safe',
    runtimeFootprint: 'throughput',
    startupArgs: [],
    username: 'postgres',
    database: 'postgres',
    extensions: [],
    maxClientSessions: 1,
    brokerMaxRoots: 1,
    brokerTransport: 'auto',
    ...overrides,
  };
}

function testPgwireStartupCancelAndBackendKeyFrames(): void {
  const startup = encodeStartupMessage('postgres', 'app');
  assert.equal(startup[4], 0);
  assert.equal(startup[5], 3);
  assert.equal(new TextDecoder().decode(startup).includes('client_encoding'), true);
  assert.throws(() => encodeStartupMessage('bad\0user', 'app'), /NUL bytes/);

  const cancel = encodeCancelRequest({ processId: 123, secretKey: 456 });
  assert.equal(cancel.byteLength, 16);
  assert.deepEqual(parseBackendKeyData(new Uint8Array([0, 0, 0, 123, 0, 0, 1, 200])), {
    processId: 123,
    secretKey: 456,
  });
  assert.throws(() => parseBackendKeyData(new Uint8Array([1, 2, 3])), /invalid/);
}

async function testNodeAdapterUtilities(): Promise<void> {
  assert.equal(randomHexToken(4).length, 8);
  assert.deepEqual(parseReadyEndpoint('unix:/tmp/oliphaunt.sock'), {
    kind: 'unix',
    path: '/tmp/oliphaunt.sock',
  });
  assert.deepEqual(parseReadyEndpoint('tcp:127.0.0.1:5432'), {
    kind: 'tcp',
    host: '127.0.0.1',
    port: 5432,
  });
  assert.deepEqual(parseReadyEndpoint('localhost:15432'), {
    kind: 'tcp',
    host: 'localhost',
    port: 15432,
  });
  assert.throws(() => parseReadyEndpoint('localhost:not-a-port'), /invalid TCP endpoint port/);
  assert.throws(() => parseReadyEndpoint('localhost'), /invalid TCP endpoint/);

  const dir = await createTempDir('oliphaunt-js-node-adapter-');
  const file = join(dir, 'file');
  await writeFile(file, 'ok');
  await chmod(file, 0o600);
  assert.equal((await canonicalPath(file)).endsWith('/file'), true);
  assert.equal(await canonicalPath(join(dir, 'missing')), join(dir, 'missing'));
  await removeTree(dir);
  await removeTree(undefined);
}

test('runtime modes', async () => {
  await main();
});
