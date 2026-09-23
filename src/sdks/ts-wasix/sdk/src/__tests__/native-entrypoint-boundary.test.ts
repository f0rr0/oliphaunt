import { expect, it, vi } from 'bun:test';

vi.mock('../physical-archive.js', () => {
  throw new Error('native entrypoint loaded browser archive code');
});
vi.mock('../storage-provider.js', () => {
  throw new Error('native entrypoint loaded browser storage providers');
});

it('loads native entrypoints without browser archive or storage providers', async () => {
  for (const entry of ['../index.node.js', '../direct.node.js', '../worker-entry.node.js']) {
    expect(typeof (await import(entry)).Oliphaunt.open).toBe('function');
  }
  expect(typeof (await import('../server.node.js')).openServer).toBe('function');
});
