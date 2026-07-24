import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  buildStartupArgs,
  normalizeDurability,
  normalizeOpenConfig,
  normalizeRuntimeFootprint,
  validateBrokerMaxRoots,
  validateBrokerTransport,
  validateMaxClientSessions,
  validateOptionalPathOverride,
  validateExtensionIds,
  validateRootPath,
  validateServerPort,
  validateStartupGUCs,
  validateStartupIdentity,
} from '../config.js';
import {
  GENERATED_EXTENSION_METADATA,
  generatedExtensionBySqlName,
  generatedSharedPreloadLibraries,
} from '../generated/extensions.js';

function throwsMessage(fn: () => unknown, message: RegExp): void {
  assert.throws(fn, message);
}

test('normalizes explicit config contracts for broker and server modes', () => {
  const broker = normalizeOpenConfig(
    {
      engine: 'nativeBroker',
      root: '/app/root',
      durability: 'balanced',
      runtimeFootprint: 'balancedMobile',
      brokerExecutable: '/opt/oliphaunt-broker',
      brokerMaxRoots: 8,
      brokerTransport: 'tcp',
      maxClientSessions: 1,
      username: 'app_user',
      database: 'app_db',
      extensions: [' vector ', '', 'hstore'],
    },
    '/app/root',
  );

  assert.equal(broker.pgdata, '/app/root/pgdata');
  assert.equal(broker.durability, 'balanced');
  assert.equal(broker.runtimeFootprint, 'balancedMobile');
  assert.equal(broker.brokerExecutable, '/opt/oliphaunt-broker');
  assert.equal(broker.brokerMaxRoots, 8);
  assert.equal(broker.brokerTransport, 'tcp');
  assert.deepEqual(broker.extensions, ['vector', 'hstore']);
  assert.ok(broker.startupArgs.includes('max_connections=1'));
  assert.ok(broker.startupArgs.includes('synchronous_commit=off'));

  const server = normalizeOpenConfig(
    {
      engine: 'nativeServer',
      root: '/server/root',
      runtimeFootprint: 'smallMobile',
      durability: 'fastDev',
      serverExecutable: '/opt/postgres',
      serverToolDirectory: '/opt/postgres/bin',
      serverPort: 15432,
    },
    '/server/root',
  );

  assert.equal(server.maxClientSessions, 32);
  assert.equal(server.serverPort, 15432);
  assert.equal(server.serverExecutable, '/opt/postgres');
  assert.equal(server.serverToolDirectory, '/opt/postgres/bin');
  assert.ok(server.startupArgs.includes('shared_buffers=8MB'));
  assert.ok(server.startupArgs.includes('fsync=off'));
});

test('validates config error surfaces deterministically', () => {
  validateRootPath(undefined, 'database root');
  validateStartupIdentity(undefined, 'username');
  assert.equal(validateOptionalPathOverride(undefined, 'libraryPath'), undefined);
  assert.equal(validateMaxClientSessions(undefined, 'nativeDirect'), 1);
  assert.equal(validateMaxClientSessions(undefined, 'nativeServer'), 32);
  assert.equal(validateBrokerMaxRoots(undefined), 1);
  assert.equal(validateServerPort(undefined), undefined);
  assert.equal(validateBrokerTransport('auto'), 'auto');
  assert.equal(validateBrokerTransport('unix'), 'unix');

  throwsMessage(() => validateRootPath('', 'restore root'), /restore root must not be empty/);
  throwsMessage(() => validateRootPath('\0', 'restore root'), /restore root must not contain NUL/);
  throwsMessage(() => validateRootPath('', 'custom path'), /custom path must not be empty/);
  throwsMessage(() => validateRootPath('\0', 'custom path'), /custom path must not contain NUL/);
  throwsMessage(() => validateStartupIdentity(' \t', 'database'), /database must not be empty/);
  throwsMessage(
    () => validateStartupIdentity('bad\0db', 'database'),
    /database must not contain NUL/,
  );
  throwsMessage(
    () => validateOptionalPathOverride(' ', 'libraryPath'),
    /libraryPath must not be empty/,
  );
  throwsMessage(
    () => validateOptionalPathOverride('\0', 'runtimeDirectory'),
    /runtimeDirectory must not contain NUL/,
  );
  throwsMessage(
    () => validateOptionalPathOverride('', 'brokerExecutable'),
    /brokerExecutable must not be empty/,
  );
  throwsMessage(
    () => validateOptionalPathOverride('\0', 'serverExecutable'),
    /serverExecutable must not contain NUL/,
  );
  throwsMessage(
    () => validateOptionalPathOverride('', 'serverToolDirectory'),
    /serverToolDirectory must not be empty/,
  );
  throwsMessage(
    () => validateOptionalPathOverride('\0', 'custom executable'),
    /custom executable must not contain NUL/,
  );
  throwsMessage(() => validateMaxClientSessions(1.5, 'nativeDirect'), /must be an integer/);
  throwsMessage(() => validateMaxClientSessions(0, 'nativeServer'), /greater than zero/);
  throwsMessage(() => validateMaxClientSessions(2, 'nativeDirect'), /supports exactly 1/);
  throwsMessage(() => validateBrokerMaxRoots(1.5), /must be an integer/);
  throwsMessage(() => validateBrokerMaxRoots(0), /max_roots must be greater than zero/);
  throwsMessage(() => validateServerPort(1.5), /port must be an integer/);
  throwsMessage(() => validateServerPort(0), /range 1..65535/);
  throwsMessage(() => validateServerPort(65_536), /range 1..65535/);
  throwsMessage(
    () => validateBrokerTransport('named-pipe' as never),
    /unknown native broker transport/,
  );
  throwsMessage(
    () => normalizeRuntimeFootprint('desktopTiny' as never),
    /unknown liboliphaunt runtime footprint/,
  );
  throwsMessage(() => normalizeDurability('unsafe' as never), /unknown liboliphaunt durability/);
  throwsMessage(() => validateStartupGUCs(['missing_equals']), /must use name=value/);
  throwsMessage(
    () => validateStartupGUCs([{ name: 'work_mem', value: '' }]),
    /value must not be empty/,
  );
  throwsMessage(() => validateStartupGUCs([{ name: 'bad-name', value: '1' }]), /must contain only/);
  throwsMessage(
    () => validateStartupGUCs([{ name: 'ok', value: 'bad\0' }]),
    /must not contain NUL/,
  );
  assert.deepEqual(validateExtensionIds([' earthdistance ', '', 'cube']), [
    'earthdistance',
    'cube',
  ]);
  throwsMessage(() => validateExtensionIds(['bad/value']), /extension id/);
  throwsMessage(
    () => validateExtensionIds(['pg_search']),
    /unknown Oliphaunt extension id 'pg_search'/,
  );
});

test('uses generated extension metadata for startup requirements', () => {
  assert.equal(GENERATED_EXTENSION_METADATA.length, 39);
  assert.deepEqual(generatedExtensionBySqlName('earthdistance')?.selectedExtensionDependencies, [
    'cube',
  ]);
  assert.deepEqual(generatedExtensionBySqlName('pgtap')?.dependencies, ['plpgsql']);
  assert.deepEqual(generatedExtensionBySqlName('pgtap')?.selectedExtensionDependencies, []);
  const postgis = generatedExtensionBySqlName('postgis');
  assert.equal(postgis?.nativeModuleStem, 'postgis-3');
  assert.ok(
    postgis?.dataFiles.includes('share/postgresql/contrib/postgis-3.6/spatial_ref_sys.sql'),
    'PostGIS metadata must include its contrib data files',
  );
  assert.ok(
    postgis?.dataFiles.includes('share/postgresql/proj/proj.db'),
    'PostGIS metadata must include PROJ data',
  );
  assert.deepEqual(
    postgis?.dataFiles.map((file) => file.replace(/^share\/postgresql\//, '')),
    postgis?.runtimeShareDataFiles,
    'PostGIS packaged data files must match runtime share data files',
  );
  assert.equal(generatedExtensionBySqlName('pg_search'), undefined);
  assert.deepEqual(generatedSharedPreloadLibraries(['hstore', 'pg_search']), []);

  const args = buildStartupArgs({
    durability: 'safe',
    runtimeFootprint: 'throughput',
    startupGUCs: [{ name: 'app.setting', value: 'enabled' }],
    extensions: ['hstore'],
  });
  assert.ok(args.includes('app.setting=enabled'));
  assert.equal(
    args.some((value) => value.startsWith('shared_preload_libraries=')),
    false,
    'extensions without generated preload rules must not create startup preload rules',
  );
  throwsMessage(
    () =>
      buildStartupArgs({
        durability: 'safe',
        runtimeFootprint: 'throughput',
        extensions: ['hstore', 'pg_search'],
      }),
    /unknown Oliphaunt extension id 'pg_search'/,
  );
});
