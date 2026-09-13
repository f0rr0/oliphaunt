import { expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../internal-common.js', () => ({ runWasixToolProcess: runtime.run }));
vi.mock('../database.js', () => ({
  getWasixDatabaseIdentity: () => ({
    username: '-application user',
    database: '-application database',
  }),
}));
import { runWasixToolProcess } from '../internal.js';
import type { OliphauntDatabase } from '../types.js';
it('adds browser connection and input arguments once, without splitting user values', () => {
  for (const name of ['pg_dump', 'psql'] as const) {
    runWasixToolProcess({} as OliphauntDatabase, {
      runtimeVersion: '0.1.1',
      tool: { name, source: 'file:///tool.wasm', sha256: 'a'.repeat(64), size: 1 },
      args: ['--schema=public'],
      ...(name === 'psql' ? { command: 'select 1' } : {}),
    });
    const args = runtime.run.mock.calls.at(-1)?.[1].args;
    expect(args.slice(0, 1)).toEqual(['--schema=public']);
    expect(args.filter((arg: string) => arg.startsWith('--username='))).toEqual([
      '--username=-application user',
    ]);
    expect(args).toContain('--dbname=-application database');
    expect(args).toContain(name === 'psql' ? '--no-psqlrc' : '--encoding=UTF8');
    if (name === 'psql') expect(args.slice(-2)).toEqual(['--command', 'select 1']);
  }
});
