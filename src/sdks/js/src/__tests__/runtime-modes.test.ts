import assert from 'node:assert/strict';
import { test } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { NormalizedOpenConfig } from '../config.js';
import {
  brokerCapabilities,
  brokerModeSupport,
  brokerReleaseTarget,
  createBrokerRuntimeBinding,
  oliphauntBrokerReleaseAssetUrl,
  restorePhysicalArchiveWithBroker,
} from '../runtime/broker.js';
import {
  canonicalPath,
  createTempDir,
  parseReadyEndpoint,
  randomHexToken,
  removeTree,
} from '../runtime/node-adapter.js';
import {
  encodeCancelRequest,
  encodeStartupMessage,
  parseBackendKeyData,
} from '../runtime/pgwire.js';
import {
  createServerRuntimeBinding,
  serverCapabilities,
  serverConnectionString,
  serverModeSupport,
} from '../runtime/server.js';

async function main(): Promise<void> {
  testBrokerCapabilitiesAndReleaseUrl();
  await testBrokerSupportAndRestoreFailureAreActionable();
  await testBrokerStartupTimeoutEnvIsValidatedBeforeNativeInstall();
  testServerCapabilitiesAndConnectionString();
  await testServerSupportReportsMissingExecutable();
  await testServerStartupTimeoutEnvIsValidatedBeforeProcessSetup();
  testPgwireStartupCancelAndBackendKeyFrames();
  await testNodeAdapterUtilities();
}

function testBrokerCapabilitiesAndReleaseUrl(): void {
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
  assert.equal(
    oliphauntBrokerReleaseAssetUrl('0.1.0', 'oliphaunt-broker-0.1.0-macos-arm64.tar.gz'),
    'https://github.com/f0rr0/oliphaunt/releases/download/oliphaunt-broker-v0.1.0/oliphaunt-broker-0.1.0-macos-arm64.tar.gz',
  );
  const windowsBrokerTarget = brokerReleaseTarget('0.1.0', 'win32', 'x64');
  assert.equal(windowsBrokerTarget.id, 'windows-x64-msvc');
  assert.equal(windowsBrokerTarget.assetName, 'oliphaunt-broker-0.1.0-windows-x64-msvc.zip');
  assert.equal(windowsBrokerTarget.executableRelativePath, 'bin/oliphaunt-broker.exe');
  assert.throws(() => oliphauntBrokerReleaseAssetUrl('../bad', 'asset.tar.gz'), /invalid/);
  assert.throws(() => oliphauntBrokerReleaseAssetUrl('0.1.0', '../asset.tar.gz'), /invalid/);
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
