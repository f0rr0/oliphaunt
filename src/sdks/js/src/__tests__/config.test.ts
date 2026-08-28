import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

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
      startupGUCs: { work_mem: '16MB' },
      username: 'app_user',
      database: 'app_db',
      extensions: [' vector ', '', 'hstore'],
    },
    { instanceDirectory: '/app/root', temporaryDirectory: false },
  );
  assert.equal(broker.topology, 'broker');
  assert.equal(broker.pgdata, '/app/root/pgdata');
  assert.equal(broker.brokerExecutable, '/opt/oliphaunt-broker');
  assert.deepEqual(broker.extensions, ['vector', 'hstore']);
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
      new URL('../../../../shared/fixtures/postgres/server-listen.json', import.meta.url),
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
