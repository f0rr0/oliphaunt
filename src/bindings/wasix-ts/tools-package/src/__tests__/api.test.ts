import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { pgDump, PostgresToolError, psql } from '../index.js';
import { toolRuntimeCalls, toolRuntimeResponses } from './wasix-ts-runtime.js';

type LogicalToolsFixture = Readonly<{
  pgDump: Readonly<{
    acceptedArgs: readonly string[];
    acceptedArgv: readonly (readonly string[])[];
    rejectedArgs: readonly string[];
    rejectedArgv: readonly (readonly string[])[];
  }>;
  psql: Readonly<{
    acceptedArgs: readonly string[];
    acceptedArgv: readonly (readonly string[])[];
    rejectedArgs: readonly string[];
    rejectedArgv: readonly (readonly string[])[];
  }>;
}>;

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../../shared/fixtures/postgres/logical-tools.json', import.meta.url),
    'utf8',
  ),
) as LogicalToolsFixture;

// liboliphaunt-doc-example:wasix-typescript-tools
describe('WASIX tools public validation', () => {
  const database = {} as never;

  it('accepts every shared ordinary pg_dump argument before invoking the runtime', async () => {
    for (const argument of fixture.pgDump.acceptedArgs) {
      const failure = await pgDump(database, { args: [argument] }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PostgresToolError);
      expect((failure as Error).cause).toMatchObject({
        message: 'unexpected WASIX tool runtime call in validation test',
      });
    }
    for (const args of fixture.pgDump.acceptedArgv) {
      const failure = await pgDump(database, { args }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PostgresToolError);
      expect((failure as Error).cause).toMatchObject({
        message: 'unexpected WASIX tool runtime call in validation test',
      });
    }
  });

  it('rejects every shared managed pg_dump argument', async () => {
    for (const argument of fixture.pgDump.rejectedArgs) {
      await expect(pgDump(database, { args: [argument] })).rejects.toThrow(/managed/);
    }
    for (const args of fixture.pgDump.rejectedArgv) {
      await expect(pgDump(database, { args })).rejects.toThrow(/managed|requires a value/);
    }
  });

  it('requires one unambiguous non-interactive psql input', async () => {
    await expect(psql(database)).rejects.toThrow(/requires non-interactive input/);
    await expect(psql(database, { command: 'select 1', script: 'select 2' })).rejects.toThrow(
      /command or script/,
    );
    for (const argument of fixture.psql.rejectedArgs) {
      await expect(psql(database, { args: [argument] })).rejects.toThrow(/managed/);
    }
    for (const args of fixture.psql.rejectedArgv) {
      await expect(psql(database, { args })).rejects.toThrow(/managed|requires a value/);
    }
  });

  it('accepts every shared ordinary psql argument before invoking the runtime', async () => {
    for (const argument of fixture.psql.acceptedArgs) {
      const failure = await psql(database, { args: [argument], command: 'select 1' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PostgresToolError);
      expect((failure as Error).cause).toMatchObject({
        message: 'unexpected WASIX tool runtime call in validation test',
      });
    }
    for (const args of fixture.psql.acceptedArgv) {
      const failure = await psql(database, { args, command: 'select 1' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PostgresToolError);
      expect((failure as Error).cause).toMatchObject({
        message: 'unexpected WASIX tool runtime call in validation test',
      });
    }
  });

  it('passes the database startup identity through unambiguous managed long options', async () => {
    toolRuntimeCalls.length = 0;
    await pgDump(database).catch(() => undefined);
    await psql(database, { command: 'select 1' }).catch(() => undefined);

    expect(toolRuntimeCalls).toHaveLength(2);
    for (const call of toolRuntimeCalls) {
      expect(call.args).toContain('--username=-application user');
      expect(call.args).toContain('--dbname=-application database');
      expect(call.args).not.toContain('-application database');
    }
  });

  it('marks stdin scripts as non-interactive psql files', async () => {
    toolRuntimeCalls.length = 0;
    await psql(database, { script: 'select 1' }).catch(() => undefined);
    await psql(database, { command: 'select 1' }).catch(() => undefined);

    expect(toolRuntimeCalls[0]?.args).toContain('--file=-');
    expect(toolRuntimeCalls[0]?.args).not.toContain('--command');
    expect(toolRuntimeCalls[1]?.args).not.toContain('--file=-');
    expect(toolRuntimeCalls[1]?.args).toContain('--command');
  });

  it('strictly decodes successful output once at the public boundary', async () => {
    toolRuntimeResponses.push({
      exitCode: 0,
      stdout: new TextEncoder().encode('standard PostgreSQL output\n'),
      stderr: Uint8Array.of(0xff),
    });

    await expect(pgDump(database)).resolves.toBe('standard PostgreSQL output\n');
  });

  it('preserves lossy diagnostics when successful output is not valid UTF-8', async () => {
    toolRuntimeResponses.push({
      exitCode: 0,
      stdout: Uint8Array.of(0xff),
      stderr: new TextEncoder().encode('diagnostic'),
    });

    const failure = await pgDump(database).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgresToolError);
    expect(failure).toMatchObject({
      tool: 'pg_dump',
      exitCode: 0,
      stdout: '\ufffd',
      stderr: 'diagnostic',
    });
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it('keeps nonzero output as best-effort structured diagnostics', async () => {
    toolRuntimeResponses.push({
      exitCode: 7,
      stdout: Uint8Array.of(0xff),
      stderr: Uint8Array.from([...new TextEncoder().encode('failed: '), 0xff]),
    });

    const failure = await psql(database, { command: 'select 1' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PostgresToolError);
    expect(failure).toMatchObject({
      tool: 'psql',
      exitCode: 7,
      stdout: '\ufffd',
      stderr: 'failed: \ufffd',
    });
  });
});
