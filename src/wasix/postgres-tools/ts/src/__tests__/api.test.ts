import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PostgresToolError,
  pgDump,
  psql,
  pgDumpToFile,
  psqlToFile,
  pgDumpToStream,
  psqlToStream,
} from '../index.js';
import {
  toolRuntimeCalls,
  toolRuntimeResponses,
  toolRuntimeFailures,
  toolRuntimeExecutions,
} from './wasix-ts-runtime.js';

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
    new URL('../../../../../test-fixtures/postgres/logical-tools.json', import.meta.url),
    'utf8',
  ),
) as LogicalToolsFixture;

describe('WASIX tools public validation', () => {
  const database = {} as never;

  it('awaits destination acceptance and releases caller-owned writer locks', async () => {
    let release!: () => void;
    let entered!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const chunks: number[] = [];
    const destination = new WritableStream<Uint8Array>({
      async write(chunk) {
        chunks.push(chunk[0]!);
        entered();
        await first;
      },
    });
    const summary = {
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      stdoutBytes: 2,
      stderrTruncated: false,
    };
    toolRuntimeExecutions.push(async ({ output }) => {
      await output!.stdout(Uint8Array.of(1));
      await output!.stdout(Uint8Array.of(2));
      return summary;
    });
    const running = pgDumpToStream(database, destination);
    await writing;
    expect(chunks).toEqual([1]);
    expect(destination.locked).toBe(true);
    release();
    await expect(running).resolves.toMatchObject({ stdoutBytes: 2 });
    expect(chunks).toEqual([1, 2]);
    expect(destination.locked).toBe(false);
  });

  it('a failed diagnostic sink wakes a stalled stdout write and preserves completed SQL metadata', async () => {
    const failure = new Error('diagnostic sink failed');
    const destination = new WritableStream<Uint8Array>({
      write: () => new Promise<void>(() => {}),
    });
    const stderr = new WritableStream<Uint8Array>({
      write() {
        throw failure;
      },
    });
    toolRuntimeExecutions.push(async ({ output }) => {
      await Promise.allSettled([
        output!.stdout(Uint8Array.of(1)),
        output!.stderr!(Uint8Array.of(2)),
      ]);
      throw Object.assign(new Error('tool output failed'), {
        oliphauntWasixError: 'tool',
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode('last diagnostic'),
        stderrTruncated: true,
      });
    });
    const error = await psqlToStream(database, destination, {
      command: 'INSERT INTO effects VALUES (1)',
      stderr,
    }).catch((error) => error);
    expect(error).toMatchObject({ exitCode: 0, cause: failure, stderrTruncated: true });
    expect(destination.locked).toBe(false);
    expect(stderr.locked).toBe(false);
  });

  it('cancellation releases a stalled write and pre-aborted input never runs', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel output');
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const destination = new WritableStream<Uint8Array>({
      write() {
        entered();
        return new Promise<void>(() => {});
      },
    });
    toolRuntimeExecutions.push(async ({ output }) => {
      await output!.stdout(Uint8Array.of(1)).catch(() => undefined);
      return {
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stdoutBytes: 1,
        stderrTruncated: false,
      };
    });
    const running = pgDumpToStream(database, destination, { signal: controller.signal });
    await writing;
    controller.abort(reason);
    await expect(running).rejects.toMatchObject({ exitCode: 0, cause: reason });
    expect(destination.locked).toBe(false);
    const calls = toolRuntimeCalls.length;
    await expect(pgDumpToStream(database, destination, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(toolRuntimeCalls.length).toBe(calls);
  });

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

  it('passes user arguments and input without manufacturing native connection arguments', async () => {
    toolRuntimeCalls.length = 0;
    await pgDump(database, { args: ['--schema-only'] }).catch(() => undefined);
    await psql(database, { command: 'select 1' }).catch(() => undefined);
    await psql(database, { script: 'select 2' }).catch(() => undefined);
    expect(toolRuntimeCalls[0]?.args).toEqual(['--schema-only']);
    expect(toolRuntimeCalls[1]?.args).toEqual([]);
    expect(toolRuntimeCalls[1]?.command).toBe('select 1');
    expect(toolRuntimeCalls[2]?.args).toEqual([]);
    expect(toolRuntimeCalls[2]?.script).toBe('select 2');
  });

  it('strictly decodes successful output once at the public boundary', async () => {
    toolRuntimeResponses.push({
      exitCode: 0,
      stdout: new TextEncoder().encode('standard PostgreSQL output\n'),
      stderr: Uint8Array.of(0xff),
    });

    await expect(pgDump(database)).resolves.toBe('standard PostgreSQL output\n');
  });

  it('validates host destinations before execution and preserves completion metadata', async () => {
    for (const path of ['', 'bad\0path']) {
      await expect(pgDumpToFile(database, path)).rejects.toThrow(/host path/);
    }
    await expect(psqlToFile(database, 'out.sql', { args: ['--file=unmanaged'] })).rejects.toThrow(
      /managed/,
    );
    toolRuntimeResponses.push({
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('tail'),
      stdoutBytes: 70 * 1024 * 1024,
      stderrTruncated: true,
    });
    await expect(pgDumpToFile(database, 'out.sql', { args: ['--schema-only'] })).resolves.toEqual({
      stdoutBytes: 70 * 1024 * 1024,
      stderr: 'tail',
      stderrTruncated: true,
    });
    expect(toolRuntimeCalls.at(-1)).toMatchObject({
      outputFile: 'out.sql',
      args: ['--schema-only'],
    });
    const cause = Object.assign(new Error('destination already exists'), {
      oliphauntWasixError: 'tool',
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('bounded tail'),
      stderrTruncated: true,
    });
    toolRuntimeFailures.push(cause);
    const failure = await psqlToFile(database, 'out.sql', {
      command: 'INSERT INTO effects VALUES (1)',
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(PostgresToolError);
    expect(failure).toMatchObject({
      exitCode: 0,
      stderr: 'bounded tail',
      stderrTruncated: true,
      cause,
    });
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

  it('wraps runtime type errors while preserving input-validation errors', async () => {
    const cause = new TypeError('invalid tool runtime result');
    toolRuntimeFailures.push(cause);
    const failure = await pgDump(database).catch((error) => error);
    expect(failure).toBeInstanceOf(PostgresToolError);
    expect(failure.cause).toBe(cause);
    await expect(
      psql(database, { command: 'select 1', script: 'select 2' }),
    ).rejects.toBeInstanceOf(TypeError);
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
