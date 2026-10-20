import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extensions, normalizeExtensions } from '../extensions.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'bun:test';

import {
  buildStartupArgs,
  normalizeOpenConfig,
  validateDirectoryPath,
  validateExtensionIds,
  validateOptionalPathOverride,
  validateServerPort,
  validateStartupGUCs,
  validateStartupIdentity,
} from '../config.js';

test('extension descriptors snapshot package identity and resolve dependencies', () => {
  const selected = {
    ...extensions.earthdistance,
    version: '9.8.7',
    packageJsonUrl: 'file:///selected/package.json',
  };
  const normalized = normalizeExtensions([selected]);
  selected.version = 'mutated';
  assert.deepEqual(
    normalized.map((value) => [value.sqlName, value.version]),
    [
      ['earthdistance', '9.8.7'],
      ['cube', '9.8.7'],
    ],
  );
  assert.ok(normalized.every(Object.isFrozen));
  assert.throws(
    () => normalizeExtensions([...normalized, { ...normalized[0]!, version: 'different' }]),
    /conflicting selected extension packages/,
  );
  assert.throws(
    () => normalizeExtensions([normalized[0]!, { ...extensions.cube, version: 'different' }]),
    /conflicting selected extension packages/,
  );
  assert.throws(() => normalizeExtensions(['vector'] as never), /extension descriptors/);
});

test('normalizes only the public database and server configuration', () => {
  const direct = normalizeOpenConfig(
    {},
    { instanceDirectory: '/temporary/root', temporaryDirectory: true },
  );
  assert.equal(direct.topology, 'direct');

  const broker = normalizeOpenConfig(
    {
      topology: 'broker',
      storage: { kind: 'directory', path: '/app/root' },
      brokerExecutable: '/opt/oliphaunt-broker',
      broker: { handshakeTimeoutMs: 750 },
      startupGUCs: { work_mem: '16MB' },
      username: 'app_user',
      database: 'app_db',
      extensions: [extensions.cube, extensions.hstore],
    },
    { instanceDirectory: '/app/root', temporaryDirectory: false },
  );
  assert.equal(broker.topology, 'broker');
  assert.equal(broker.pgdata, '/app/root/pgdata');
  assert.equal(broker.brokerExecutable, '/opt/oliphaunt-broker');
  assert.equal(broker.brokerHandshakeTimeoutMs, 750);
  assert.deepEqual(broker.extensions, ['cube', 'hstore']);
  assert.deepEqual(broker.startupArgs.slice(0, 2), ['-c', 'work_mem=16MB']);

  const server = normalizeOpenConfig(
    {
      topology: 'server',
      serverExecutable: '/opt/postgres',
      listen: { transport: 'tcp', port: 15432 },
    },
    { instanceDirectory: '/server/root', temporaryDirectory: true },
  );
  assert.equal(server.topology, 'server');
  assert.equal(server.serverExecutable, '/opt/postgres');
  assert.deepEqual(server.serverListen, { transport: 'tcp', port: 15432 });

  const unixServer = normalizeOpenConfig(
    {
      topology: 'server',
      listen: { transport: 'unix', directory: '/tmp/oliphaunt sockets' },
    },
    { instanceDirectory: '/server/root', temporaryDirectory: true },
  );
  assert.deepEqual(unixServer.serverListen, {
    transport: 'unix',
    directory: '/tmp/oliphaunt sockets',
  });
});

test('broker handshake options are validated and copied before launch', () => {
  const root = { instanceDirectory: '/app/root', temporaryDirectory: false };
  const options = { handshakeTimeoutMs: 125 };
  const normalized = normalizeOpenConfig({ topology: 'broker', broker: options }, root);
  options.handshakeTimeoutMs = 500;
  assert.equal(normalized.brokerHandshakeTimeoutMs, 125);
  assert.equal(
    normalizeOpenConfig({ topology: 'broker' }, root).brokerHandshakeTimeoutMs,
    undefined,
  );
  for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, '5000', null]) {
    assert.throws(() =>
      normalizeOpenConfig(
        { topology: 'broker', broker: { handshakeTimeoutMs: value } } as never,
        root,
      ),
    );
  }
  for (const broker of [null, [], '5000', { handshakeTimeout: 5000 }]) {
    assert.throws(() => normalizeOpenConfig({ topology: 'broker', broker } as never, root));
  }
  for (const topology of ['direct', 'server', undefined]) {
    assert.throws(
      () => normalizeOpenConfig({ topology, broker: options } as never, root),
      /require topology/,
    );
  }
  assert.equal(
    normalizeOpenConfig({ topology: 'broker', broker: { handshakeTimeoutMs: 2_147_483_647 } }, root)
      .brokerHandshakeTimeoutMs,
    2_147_483_647,
  );
});

test('validates the small public configuration vocabulary', () => {
  validateDirectoryPath(undefined, 'database storage directory');
  validateStartupIdentity(undefined, 'username');
  assert.equal(validateOptionalPathOverride(undefined, 'libraryPath'), undefined);
  assert.equal(validateServerPort(undefined), undefined);

  assert.throws(() => validateDirectoryPath('', 'restore destination'), /must not be empty/);
  assert.throws(() => validateDirectoryPath('\0', 'restore destination'), /must not contain NUL/);
  assert.throws(() => validateStartupIdentity(' ', 'database'), /must not be empty/);
  assert.throws(() => validateOptionalPathOverride(' ', 'libraryPath'), /must not be empty/);
  assert.throws(() => validateServerPort(1.5), /must be an integer/);
  assert.throws(() => validateServerPort(0), /range 1\.\.65535/);
  assert.throws(() => validateServerPort(65_536), /range 1\.\.65535/);
  assert.deepEqual(validateStartupGUCs({ _name: '16MB', 'ext.name$1': 'on' }), [
    '_name=16MB',
    'ext.name$1=on',
  ]);
  for (const name of ['1name', '.foo', 'a..b', 'a.1b', 'ext.$name', 'bad-name']) {
    assert.throws(() => validateStartupGUCs({ [name]: '1' }), /each dot-separated component/);
  }
  assert.deepEqual(validateStartupGUCs({ search_path: '' }), ['search_path=']);
  assert.deepEqual(
    validateStartupGUCs({ WORK_MEM: '8MB', search_path: 'public', work_mem: '16MB' }),
    ['search_path=public', 'work_mem=16MB'],
  );
  assert.throws(() => validateStartupGUCs({ good: 'bad\0value' }), /must not contain NUL/);
  assert.deepEqual(validateExtensionIds([' earthdistance ', '', 'cube']), [
    'earthdistance',
    'cube',
  ]);
  assert.throws(() => validateExtensionIds(['bad/value']), /extension id/);
  assert.throws(() => validateExtensionIds(['pg_search']), /unknown Oliphaunt extension/);
});

test('matches the shared server-listen port contract', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../../test-fixtures/postgres/server-listen.json', import.meta.url),
      'utf8',
    ),
  ) as {
    tcp: { validPorts: number[]; invalidPorts: number[] };
    unix: { defaultPort: number; filePrefix: string };
  };
  for (const port of fixture.tcp.validPorts) assert.equal(validateServerPort(port), port);
  for (const port of fixture.tcp.invalidPorts) {
    assert.throws(() => validateServerPort(port));
  }
  assert.equal(fixture.unix.defaultPort, 5432);
  assert.equal(fixture.unix.filePrefix, '.s.PGSQL.');
});

test('builds PostgreSQL startup arguments without SDK-specific profiles', () => {
  const args = buildStartupArgs({
    startupGUCs: { 'app.setting': 'enabled' },
    extensions: ['hstore'],
  });
  assert.deepEqual(args, ['-c', 'app.setting=enabled']);
});

test('merges caller and extension preload libraries into one deduplicated assignment', () => {
  const args = buildStartupArgs({
    startupGUCs: {
      work_mem: '16MB',
      SHARED_PRELOAD_LIBRARIES: 'auto_explain, pg_textsearch, auto_explain',
    },
    extensions: ['pg_textsearch', 'pg_textsearch'],
  });

  assert.deepEqual(args, [
    '-c',
    'work_mem=16MB',
    '-c',
    'shared_preload_libraries=auto_explain,pg_textsearch',
  ]);
});

test('rejects PostgreSQL startup GUCs owned by native server topology', () => {
  for (const name of ['LISTEN_ADDRESSES', 'port', 'unix_socket_directories']) {
    assert.throws(
      () =>
        normalizeOpenConfig(
          { topology: 'server', startupGUCs: { [name]: 'override' } },
          { instanceDirectory: '/server/root', temporaryDirectory: false },
        ),
      /native server owns PostgreSQL startup GUC.*Oliphaunt\.openServer\(\)/,
    );
  }
});

test('rejects PostgreSQL startup GUCs owned by Oliphaunt storage', () => {
  for (const topology of ['direct', 'broker', 'server'] as const) {
    for (const name of ['CONFIG_FILE', 'data_directory']) {
      assert.throws(
        () =>
          normalizeOpenConfig(
            { topology, startupGUCs: { [name]: 'override' } },
            { instanceDirectory: '/database/root', temporaryDirectory: false },
          ),
        /Oliphaunt owns PostgreSQL startup GUC.*configure database storage/,
      );
    }
  }
});

test('normalizes file URL inputs consistently before native serialization', () => {
  const runtimeDirectory = join(tmpdir(), 'runtime dir');
  const serverExecutable = join(runtimeDirectory, 'bin', 'postgres');
  const icuDirectory = join(tmpdir(), 'icu data');
  const manifestPath = join(icuDirectory, 'manifest.json');
  const socketDirectory = join(tmpdir(), 'socket dir');
  const config = normalizeOpenConfig(
    {
      topology: 'server',
      runtimeDirectory: pathToFileURL(runtimeDirectory),
      serverExecutable: pathToFileURL(serverExecutable),
      icuData: {
        directory: pathToFileURL(icuDirectory),
        manifestPath: pathToFileURL(manifestPath),
      },
      listen: { transport: 'unix', directory: pathToFileURL(socketDirectory) },
    },
    { instanceDirectory: '/database', temporaryDirectory: false },
  );
  assert.equal(config.runtimeDirectory, runtimeDirectory);
  assert.equal(config.serverExecutable, serverExecutable);
  assert.deepEqual(config.icuData, {
    directory: icuDirectory,
    manifestPath,
  });
  assert.deepEqual(config.serverListen, { transport: 'unix', directory: socketDirectory });
  assert.throws(
    () =>
      normalizeOpenConfig(
        {
          seed: { directory: new URL('https://example.com/seed'), manifestPath: '/manifest.json' },
        },
        { instanceDirectory: '/database', temporaryDirectory: false },
      ),
    /file/,
  );
});

// Each budget has a different owner even when its default number happens to match.
test('snapshots independent broker and lifecycle controls and rejects unsupported controls', () => {
  const selected = normalizeOpenConfig(
    {
      topology: 'broker',
      broker: {
        handshakeTimeoutMs: 11,
        recoveryTimeoutMs: 22,
        maxPendingHandshakes: 3,
      },
      timeouts: { startupTimeoutMs: 44, shutdownTimeoutMs: 55 },
    },
    {
      instanceDirectory: '/tmp/oliphaunt-config-budget',
      temporaryDirectory: false,
    },
  );
  assert.deepEqual(
    [
      selected.brokerHandshakeTimeoutMs,
      selected.brokerRecoveryTimeoutMs,
      selected.brokerMaxPendingHandshakes,
      selected.timeouts,
    ],
    [11, 22, 3, { startupTimeoutMs: 44, shutdownTimeoutMs: 55 }],
  );
  for (const broker of [
    { recoveryTimeoutMs: 0 },
    { maxPendingHandshakes: 0 },
    { maxPendingHandshakes: 0x1_0000_0000 },
  ]) {
    assert.throws(() =>
      normalizeOpenConfig(
        { topology: 'broker', broker },
        { instanceDirectory: '/tmp/unused', temporaryDirectory: false },
      ),
    );
  }
  assert.throws(
    () =>
      normalizeOpenConfig(
        { timeouts: { startupTimeoutMs: 1 } },
        { instanceDirectory: '/tmp/unused', temporaryDirectory: false },
      ),
    /broker or server/,
  );
});
