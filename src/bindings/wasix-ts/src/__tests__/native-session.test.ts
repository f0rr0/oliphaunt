import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WasixDatabaseImpl } from '../database.js';
import { WasixStorageError } from '../errors.js';
import type {
  NativeWasixAddon,
  NativeWasixActorDatabaseHandle,
  NativeWasixDatabaseHandle,
} from '../native-addon.js';
import type { SerializedExtensionCarrier } from '../rpc.js';
import { workerOpenOptions } from './worker-helpers.js';

const nativeMocks = vi.hoisted(() => ({
  extensionIdentity: vi.fn(),
  actorOpen: vi.fn(),
  loadAddon: vi.fn(),
  open: vi.fn(),
  payloadIdentity: vi.fn(),
  pgDump: vi.fn(),
  psql: vi.fn(),
  toolIdentity: vi.fn(),
}));

vi.mock('../native-addon.js', () => ({
  loadNativeWasixAddon: nativeMocks.loadAddon,
}));

import {
  NativeWasixActorSession,
  NativeWasixSession,
  nativeWasixOpenOptions,
  requireCompatibleNativeWasixAddon,
} from '../native-session.js';

const digest = 'a'.repeat(64);

beforeEach(() => {
  for (const mock of Object.values(nativeMocks)) mock.mockReset();
  nativeMocks.extensionIdentity.mockReturnValue(`${digest}:7`);
  nativeMocks.toolIdentity.mockReturnValue(`${digest}:7`);
  nativeMocks.pgDump.mockReturnValue({
    status: 0,
    stdout: new TextEncoder().encode('ok'),
    stderr: new Uint8Array(),
  });
  nativeMocks.psql.mockReturnValue({
    status: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  });
  nativeMocks.payloadIdentity.mockImplementation((component: string) => {
    if (component === 'runtimeArchive') return `${'1'.repeat(64)}:1`;
    if (component === 'standardSeedArchive') return `${'2'.repeat(64)}:1`;
    if (component === 'standardSeedManifest') return `${'4'.repeat(64)}:1`;
    throw new Error(`unexpected fixture payload ${component}`);
  });
  nativeMocks.open.mockReturnValue(databaseHandle());
  nativeMocks.actorOpen.mockResolvedValue(actorDatabaseHandle());
  nativeMocks.loadAddon.mockReturnValue(addon());
});

describe('WASIX native embedded payload compatibility', () => {
  it('rejects a runtime descriptor whose archive differs from the embedded runtime', () => {
    const options = workerOpenOptions();
    nativeMocks.payloadIdentity.mockImplementation((component: string) =>
      component === 'runtimeArchive'
        ? `${'b'.repeat(64)}:1`
        : `${(component === 'standardSeedArchive' ? '2' : '4').repeat(64)}:1`,
    );

    expect(() => requireCompatibleNativeWasixAddon(options)).toThrow(
      'WASIX runtime archive descriptor does not match the native addon payload',
    );
  });

  it('accepts an extension descriptor only when its exact archive is embedded', () => {
    const options = workerOpenOptions();
    options.extensionCarriers.pgtap = extensionCarrier('pgtap');

    expect(requireCompatibleNativeWasixAddon(options)).toBe(
      nativeMocks.loadAddon.mock.results[0]?.value,
    );
    expect(nativeMocks.extensionIdentity).toHaveBeenCalledWith('pgtap');
  });

  it('rejects an extension descriptor whose archive differs from the embedded archive', () => {
    const options = workerOpenOptions();
    options.extensionCarriers.pgtap = extensionCarrier('pgtap');
    nativeMocks.extensionIdentity.mockReturnValue(`${'b'.repeat(64)}:7`);

    expect(() => requireCompatibleNativeWasixAddon(options)).toThrow(
      'WASIX extension pgtap descriptor does not match the archive embedded in the native addon',
    );
  });

  it('rejects a frontend tool descriptor whose bytes differ from the embedded module', async () => {
    const session = await NativeWasixSession.open(workerOpenOptions());
    nativeMocks.toolIdentity.mockReturnValue(`${'b'.repeat(64)}:7`);

    await expect(
      session.runTool({
        runtimeVersion: '0.1.1',
        tool: { name: 'pg_dump', sha256: digest, size: 7, source: 'embedded' },
        args: pgDumpArguments(),
      }),
    ).rejects.toThrow(
      'WASIX pg_dump descriptor does not match the tool embedded in the native addon',
    );
    expect(nativeMocks.pgDump).not.toHaveBeenCalled();
  });

  it('rejects an empty native database name before entering the addon', async () => {
    const options = workerOpenOptions();
    options.username = 'app_owner';
    options.database = '';

    await expect(NativeWasixSession.open(options)).rejects.toThrow('database must not be empty');
    expect(nativeMocks.open).not.toHaveBeenCalled();
  });

  it('maps only exact native storage tags without parsing the message', async () => {
    nativeMocks.open.mockImplementation(() => {
      throw Object.assign(new Error('this deliberately says corrupt and available'), {
        oliphauntWasixError: 'storage',
        oliphauntWasixAddonAbi: 1,
        code: 'busy',
        commitState: 'unchanged',
        phase: 'ownership',
      });
    });

    const failure = await NativeWasixSession.open(workerOpenOptions()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(WasixStorageError);
    expect(failure).toMatchObject({
      code: 'busy',
      commitState: 'unchanged',
      phase: 'ownership',
    });
  });

  it('does not guess a storage classification from an untagged native message', async () => {
    const untagged = new Error('database root is already in use and corrupt');
    nativeMocks.open.mockImplementation(() => {
      throw untagged;
    });

    const failure = await NativeWasixSession.open(workerOpenOptions()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBe(untagged);
    expect(failure).not.toBeInstanceOf(WasixStorageError);
  });

  it('preserves native tool stdout and stderr as exact bytes', async () => {
    nativeMocks.pgDump.mockReturnValue({
      status: 7,
      stdout: Uint8Array.of(0xff, 0, 0x61),
      stderr: Uint8Array.of(0x80, 0xfe),
    });
    const session = await NativeWasixSession.open(workerOpenOptions());

    const result = await session.runTool({
      runtimeVersion: '0.1.1',
      tool: { name: 'pg_dump', sha256: digest, size: 7, source: 'embedded' },
      args: pgDumpArguments(),
    });

    expect(result).toEqual({
      exitCode: 7,
      stdout: Uint8Array.of(0xff, 0, 0x61),
      stderr: Uint8Array.of(0x80, 0xfe),
    });
  });

  it('passes an immutable profile to direct and actor opens', async () => {
    const options = workerOpenOptions();

    await NativeWasixSession.open(options);
    await NativeWasixActorSession.open(options);

    expect(nativeMocks.open).toHaveBeenCalledWith(expect.objectContaining({ profile: 'standard' }));
    expect(nativeMocks.actorOpen).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'standard' }),
    );
    expect(
      nativeWasixOpenOptions(
        { ...options, icu: {} as NonNullable<typeof options.icu> },
        { kind: 'memory' },
      ).profile,
    ).toBe('icu');
  });

  it('preserves transferable direct and actor protocol, backup, and tool bytes', async () => {
    const directHandle = databaseHandle();
    directHandle.execProtocolRaw = () => Uint8Array.of(1, 2, 3);
    directHandle.backup = () => Uint8Array.of(4, 5);
    nativeMocks.open.mockReturnValue(directHandle);
    const actorHandle = actorDatabaseHandle();
    actorHandle.execProtocolRaw = async () => Uint8Array.of(6, 7, 8);
    actorHandle.backup = async () => Uint8Array.of(9, 10);
    nativeMocks.actorOpen.mockResolvedValue(actorHandle);
    nativeMocks.pgDump.mockImplementation(() => ({
      status: 0,
      stdout: Uint8Array.of(11, 12),
      stderr: Uint8Array.of(13),
    }));
    const direct = await NativeWasixSession.open(workerOpenOptions());
    const actor = await NativeWasixActorSession.open(workerOpenOptions());

    expectTransferable(await direct.exec(Uint8Array.of(0)), [1, 2, 3]);
    expectTransferable(await direct.backup(), [4, 5]);
    expectTransferable(await actor.exec(Uint8Array.of(0)), [6, 7, 8]);
    expectTransferable(await actor.backup(), [9, 10]);
    const toolOptions = {
      runtimeVersion: '0.1.1',
      tool: { name: 'pg_dump' as const, sha256: digest, size: 7, source: 'embedded' },
      args: pgDumpArguments(),
    };
    const directTool = await direct.runTool(toolOptions);
    const actorTool = await actor.runTool(toolOptions);
    expectTransferable(directTool.stdout, [11, 12]);
    expectTransferable(directTool.stderr, [13]);
    expectTransferable(actorTool.stdout, [11, 12]);
    expectTransferable(actorTool.stderr, [13]);
  });

  it('makes a quarantined direct owner terminal and rejects queued work with its first failure', async () => {
    const failure = new Error('direct owner panicked');
    const controlled = controllableDatabaseHandle();
    controlled.handle.execProtocolRaw = () => {
      controlled.retire();
      throw failure;
    };
    nativeMocks.open.mockReturnValue(controlled.handle);
    const session = await NativeWasixSession.open(workerOpenOptions());
    const database = new WasixDatabaseImpl(session);

    const first = database.execProtocolRaw(Uint8Array.of(1));
    const queued = database.execProtocolRaw(Uint8Array.of(2));

    await expect(first).rejects.toBe(failure);
    await expect(queued).rejects.toBe(failure);
    expect(session.terminalState.failure).toBe(failure);
    expect(session.terminalState.failure).toBe(failure);
    expect(database.closed).toBe(true);
    await database.close();
  });

  it('makes a stopped actor owner terminal and rejects queued work with its first failure', async () => {
    const failure = new Error('actor owner stopped');
    const controlled = controllableActorDatabaseHandle();
    controlled.handle.execProtocolRaw = async () => {
      controlled.retire();
      throw failure;
    };
    nativeMocks.actorOpen.mockResolvedValue(controlled.handle);
    const session = await NativeWasixActorSession.open(workerOpenOptions());
    const database = new WasixDatabaseImpl(session);

    const first = database.execProtocolRaw(Uint8Array.of(1));
    const queued = database.execProtocolRaw(Uint8Array.of(2));

    await expect(first).rejects.toBe(failure);
    await expect(queued).rejects.toBe(failure);
    expect(session.terminalState.failure).toBe(failure);
    expect(session.terminalState.failure).toBe(failure);
    expect(database.closed).toBe(true);
    await database.close();
  });

  it('synthesizes one stable failure when a direct owner is lost while idle', async () => {
    const controlled = controllableDatabaseHandle();
    nativeMocks.open.mockReturnValue(controlled.handle);
    const session = await NativeWasixSession.open(workerOpenOptions());
    const database = new WasixDatabaseImpl(session);

    controlled.retire();

    expect(database.closed).toBe(true);
    const failure = session.terminalState.failure;
    expect(failure).toMatchObject({
      message: 'Oliphaunt WASIX direct owner stopped unexpectedly',
    });
    expect(session.terminalState.failure).toBe(failure);
    await database.close();
  });

  it('synthesizes one stable failure when an actor owner is lost while idle', async () => {
    const controlled = controllableActorDatabaseHandle();
    nativeMocks.actorOpen.mockResolvedValue(controlled.handle);
    const session = await NativeWasixActorSession.open(workerOpenOptions());
    const database = new WasixDatabaseImpl(session);

    controlled.retire();

    expect(database.closed).toBe(true);
    const failure = session.terminalState.failure;
    expect(failure).toMatchObject({
      message: 'Oliphaunt WASIX actor owner stopped unexpectedly',
    });
    expect(session.terminalState.failure).toBe(failure);
    await database.close();
  });

  it('does not classify orderly direct or actor close as owner loss', async () => {
    const directHandle = controllableDatabaseHandle();
    const actorHandle = controllableActorDatabaseHandle();
    nativeMocks.open.mockReturnValue(directHandle.handle);
    nativeMocks.actorOpen.mockResolvedValue(actorHandle.handle);
    const direct = await NativeWasixSession.open(workerOpenOptions());
    const actor = await NativeWasixActorSession.open(workerOpenOptions());

    await direct.close();
    await actor.close();

    expect(direct.terminalState.terminal).toBe(false);
    expect(direct.terminalState.failure).toBeUndefined();
    expect(actor.terminalState.terminal).toBe(false);
    expect(actor.terminalState.failure).toBeUndefined();
  });
});

function addon(): NativeWasixAddon {
  class NativeDatabaseFixture {}
  Object.assign(NativeDatabaseFixture.prototype, databaseHandle());
  class NativeServerFixture {}
  Object.assign(NativeServerFixture.prototype, {
    connectionString: 'postgresql://fixture',
    closed: false,
    close() {},
  });
  return {
    NativeWasixDatabase: Object.assign(NativeDatabaseFixture, {
      open: nativeMocks.open,
    }) as unknown as NativeWasixAddon['NativeWasixDatabase'],
    NativeWasixActorDatabase: Object.assign(class NativeActorDatabaseFixture {}, {
      open: nativeMocks.actorOpen,
    }) as unknown as NativeWasixAddon['NativeWasixActorDatabase'],
    NativeWasixServer: Object.assign(NativeServerFixture, {
      open: vi.fn(),
    }) as unknown as NativeWasixAddon['NativeWasixServer'],
    async restore() {},
    restoreDirect() {},
    addonAbiVersion: () => 1,
    nodeApiVersion: () => 8,
    runtimeVersion: () => '0.1.1',
    supportedProfiles: () => ['standard', 'icu'],
    payloadIdentity: nativeMocks.payloadIdentity,
    extensionIdentity: nativeMocks.extensionIdentity,
    toolIdentity: nativeMocks.toolIdentity,
  };
}

function actorDatabaseHandle(): NativeWasixActorDatabaseHandle {
  return {
    closed: false,
    execProtocolRaw: async () => new Uint8Array(),
    execProtocolRawStream: async () => 'complete',
    backup: async () => new Uint8Array(),
    pgDump: async (...args) => nativeMocks.pgDump(...args),
    psql: async (...args) => nativeMocks.psql(...args),
    async close() {},
  };
}

function expectTransferable(bytes: Uint8Array, expected: number[]): void {
  const buffer = bytes.buffer as ArrayBuffer;
  const clone = structuredClone(bytes, { transfer: [buffer] });
  expect([...clone]).toEqual(expected);
  expect(buffer.byteLength).toBe(0);
}

function databaseHandle(): NativeWasixDatabaseHandle {
  return {
    closed: false,
    execProtocolRaw: () => new Uint8Array(),
    execProtocolRawStream: () => 'complete',
    backup: () => new Uint8Array(),
    pgDump: nativeMocks.pgDump,
    psql: nativeMocks.psql,
    close() {},
  };
}

function controllableDatabaseHandle(): Readonly<{
  handle: NativeWasixDatabaseHandle;
  retire(): void;
}> {
  let closed = false;
  const handle: NativeWasixDatabaseHandle = {
    get closed() {
      return closed;
    },
    execProtocolRaw: () => new Uint8Array(),
    execProtocolRawStream: () => 'complete',
    backup: () => new Uint8Array(),
    pgDump: nativeMocks.pgDump,
    psql: nativeMocks.psql,
    close() {
      closed = true;
    },
  };
  return {
    handle,
    retire() {
      closed = true;
    },
  };
}

function controllableActorDatabaseHandle(): Readonly<{
  handle: NativeWasixActorDatabaseHandle;
  retire(): void;
}> {
  let closed = false;
  const handle: NativeWasixActorDatabaseHandle = {
    get closed() {
      return closed;
    },
    execProtocolRaw: async () => new Uint8Array(),
    execProtocolRawStream: async () => 'complete',
    backup: async () => new Uint8Array(),
    pgDump: async (...args) => nativeMocks.pgDump(...args),
    psql: async (...args) => nativeMocks.psql(...args),
    async close() {
      closed = true;
    },
  };
  return {
    handle,
    retire() {
      closed = true;
    },
  };
}

function extensionCarrier(sqlName: string): SerializedExtensionCarrier {
  return {
    product: `oliphaunt-extension-${sqlName}`,
    version: '0.1.1',
    sqlName,
    archive: `${sqlName}.tar.zst`,
    sha256: digest,
    size: 7,
    source: 'embedded',
    compatibility: {
      extensionRuntimeContract: 'wasix-pg18-extension-v1',
      postgresMajor: '18',
      wasixRuntimeProduct: 'liboliphaunt-wasix',
      wasixRuntimeVersion: '0.1.1',
    },
    install: {
      schema: 'oliphaunt-wasix-extension-install-v1',
      name: sqlName,
      nativeModule: null,
      nativeModules: [],
      dependencies: [],
      coreExportsRequired: [],
      loadOrder: [],
      lifecycle: {
        createExtension: true,
        loadSql: [],
        postCreateSql: [],
        startupConfig: [],
        preloadRequired: false,
        restartRequired: false,
        sharedMemoryRequired: false,
      },
      installedFiles: [],
      unresolvedImports: [],
    },
  };
}

function pgDumpArguments(): string[] {
  return [
    '--encoding=UTF8',
    '--no-password',
    '--username=postgres',
    '--host=127.0.0.1',
    '--port=65432',
    '--dbname=postgres',
  ];
}
