import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeMocks = vi.hoisted(() => ({
  close: vi.fn(),
  mapError: vi.fn(),
  nativeOpenOptions: vi.fn(),
  open: vi.fn(),
  requireAddon: vi.fn(),
  requireNodeStorage: vi.fn(),
  serialize: vi.fn(),
}));

vi.mock('../client-common.js', () => ({
  serializeOpenConfig: nativeMocks.serialize,
}));
vi.mock('../native-session.js', () => ({
  mapNativeError: nativeMocks.mapError,
  nativeWasixOpenOptions: nativeMocks.nativeOpenOptions,
  requireCompatibleNativeWasixAddon: nativeMocks.requireAddon,
}));
vi.mock('../node-client-common.js', () => ({
  requireNodeStorage: nativeMocks.requireNodeStorage,
}));
vi.mock('../worker-node-client.js', () => {
  throw new Error('native local server loaded the JavaScript Worker relay');
});

import { openServer } from '../server.node.js';

const memoryOptions = {
  username: 'postgres',
  database: 'postgres',
  startupGUCs: {},
  extensions: [],
  storage: { kind: 'memory' as const },
};

beforeEach(() => {
  for (const mock of Object.values(nativeMocks)) mock.mockReset();
  nativeMocks.serialize.mockReturnValue(memoryOptions);
  nativeMocks.mapError.mockImplementation((error) => error);
  nativeMocks.close.mockResolvedValue(undefined);
  nativeMocks.nativeOpenOptions.mockImplementation((options, storage) => ({
    profile: options.icu === undefined ? 'standard' : 'icu',
    storage,
    username: 'postgres',
    database: 'postgres',
    startupGucs: {},
    extensions: [],
  }));
  nativeMocks.open.mockResolvedValue({
    connectionString: 'postgresql://postgres@127.0.0.1:6543/postgres?sslmode=disable',
    closed: false,
    close: nativeMocks.close,
  });
  nativeMocks.requireAddon.mockReturnValue({ NativeWasixServer: { open: nativeMocks.open } });
});

// liboliphaunt-doc-example:wasix-typescript-server
describe('WASIX native local server surface', () => {
  it('delegates TCP ownership directly to the Rust addon and closes idempotently', async () => {
    const server = await openServer();

    expect(nativeMocks.requireNodeStorage).toHaveBeenCalledWith(memoryOptions);
    expect(nativeMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'standard',
        listen: { transport: 'tcp' },
        storage: { kind: 'memory' },
      }),
    );
    expect(server.connectionString).toBe(
      'postgresql://postgres@127.0.0.1:6543/postgres?sslmode=disable',
    );
    expect(Object.isFrozen(server)).toBe(true);

    const first = server.close();
    const second = server.close();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(server.closed).toBe(true);
    expect(nativeMocks.close).toHaveBeenCalledOnce();
  });

  it('passes an absolute Unix socket directory and PostgreSQL default port to Rust', async () => {
    await openServer({ listen: { transport: 'unix', directory: 'tmp/sockets' } });

    expect(nativeMocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        listen: {
          transport: 'unix',
          directory: resolve('tmp/sockets'),
          port: 5432,
        },
      }),
    );
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])('rejects invalid TCP port %s', async (port) => {
    await expect(openServer({ listen: { transport: 'tcp', port } })).rejects.toThrow(
      'port must be an integer in 1..=65535',
    );
    expect(nativeMocks.open).not.toHaveBeenCalled();
  });

  it('passes the resolved directory directly to its Rust owner', async () => {
    const directoryOptions = {
      ...memoryOptions,
      storage: {
        kind: 'directory' as const,
        path: '/canonical/database',
      },
    };
    nativeMocks.serialize.mockReturnValue(directoryOptions);

    const server = await openServer();
    expect(nativeMocks.nativeOpenOptions).toHaveBeenCalledWith(directoryOptions, {
      kind: 'directory',
      path: '/canonical/database',
    });

    await server.close();
    expect(nativeMocks.close).toHaveBeenCalledOnce();
  });

  it('maps a structured native server-open failure at the ABI boundary', async () => {
    const openFailure = new Error('native server open failed');
    const mapped = new Error('mapped native server open failed', { cause: openFailure });
    nativeMocks.open.mockRejectedValue(openFailure);
    nativeMocks.mapError.mockReturnValue(mapped);

    const failure = await openServer().catch((error: unknown) => error);
    expect(failure).toBe(mapped);
    expect(nativeMocks.mapError).toHaveBeenCalledWith(openFailure);
  });

  it('marks closed only after the memoized native close attempt settles', async () => {
    let finishClose!: () => void;
    nativeMocks.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    );
    const server = await openServer();

    const first = server.close();
    expect(server.closed).toBe(false);
    expect(server.close()).toBe(first);
    finishClose();
    await first;

    expect(server.closed).toBe(true);
    expect(nativeMocks.close).toHaveBeenCalledOnce();
  });
});
