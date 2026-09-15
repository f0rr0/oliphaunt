import { expect, it, vi } from 'bun:test';
import type { OliphauntDatabase } from '../types.js';
import type { WasixToolProcessOptions } from '../tool-runtime.js';

const runTool = vi.fn(async (_database: OliphauntDatabase, _options: WasixToolProcessOptions) => ({
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
}));
vi.mock('../internal-common.js', () => ({ runWasixToolProcess: runTool }));
vi.mock('../database.js', () => ({
  getWasixDatabaseIdentity: () => ({
    username: '-application user',
    database: '-application database',
  }),
}));
const { runWasixToolProcess } = await import('../internal.js');

it('adds browser connection and input arguments at the execution boundary', async () => {
  for (const name of ['pg_dump', 'psql'] as const) {
    for (const input of [
      {},
      { command: 'select 1' },
      { stdin: new TextEncoder().encode('select 2') },
    ]) {
      if (name === 'pg_dump' && Object.keys(input).length !== 0) continue;
      await runWasixToolProcess({} as OliphauntDatabase, {
        runtimeVersion: '0.1.1',
        tool: { name, sha256: 'a'.repeat(64), size: 1, source: Uint8Array.of(1) },
        args: ['--verbose'],
        ...input,
      });
      expect(runTool.mock.calls.at(-1)?.[1]).toMatchObject({
        ...input,
        args: [
          '--verbose',
          ...(name === 'pg_dump'
            ? ['--encoding=UTF8', '--no-password']
            : ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1']),
          '--username=-application user',
          '--host=127.0.0.1',
          '--port=65432',
          '--dbname=-application database',
          ...('command' in input
            ? ['--command', input.command]
            : 'stdin' in input
              ? ['--file=-']
              : []),
        ],
      });
    }
  }
});
