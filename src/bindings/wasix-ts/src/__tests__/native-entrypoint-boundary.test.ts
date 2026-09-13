import { expect, it, vi } from 'vitest';
import { workerOpenOptions } from './worker-helpers.js';
const boundary = vi.hoisted(() => ({ serialize: vi.fn(), open: vi.fn() }));
vi.mock('../open-config.js', () => ({ serializeOpenConfig: boundary.serialize }));
vi.mock('../worker-rpc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worker-rpc.js')>()),
  openWasixWithWorker: boundary.open,
}));
vi.mock('../physical-archive.js', () => {
  throw new Error('native entrypoint loaded browser archive code');
});
vi.mock('../storage-provider.js', () => {
  throw new Error('native entrypoint loaded browser storage providers');
});
import { openWasix } from '../worker-node-client.js';

it('preserves optional package sources while removing only the embedded core payload sources', async () => {
  const options = {
    ...workerOpenOptions(),
    icu: { dataArchive: { source: 'file:///optional-icu.tar.zst' } },
    extensionCarriers: { vector: { source: 'file:///vector.tar.zst' } },
  };
  boundary.serialize.mockReturnValue(options);
  await openWasix();
  const forwarded = boundary.open.mock.calls[0]?.[1];
  expect(forwarded.icu).toBe(options.icu);
  expect(forwarded.extensionCarriers).toBe(options.extensionCarriers);
  expect(forwarded.runtime.runtimeArchive.source).toBe('oliphaunt:wasix-napi-embedded');
});
