import tools from '@oliphaunt/liboliphaunt-wasix-tools';
import type { OliphauntDatabase } from '@oliphaunt/wasix-ts';
import { runWasixToolProcess } from '@oliphaunt/wasix-ts/internal/tools';

assertToolsCarrier();

// PostgreSQL 18 getopt_long optstrings. A value-taking option owns the rest
// of its token, so a managed-looking character inside that value stays data.
const PG_DUMP_SHORT_OPTIONS = 'abBcCd:e:E:f:F:h:j:n:N:Op:RsS:t:T:U:vwWxXZ:';
const PSQL_SHORT_OPTIONS = 'aAbc:d:eEf:F:h:HlL:no:p:P:qR:sStT:U:v:VwWxXz?01';
const PG_DUMP_VALUE_OPTIONS = [
  '--extension',
  '--schema',
  '--exclude-schema',
  '--superuser',
  '--table',
  '--exclude-table',
  '--exclude-table-data',
  '--extra-float-digits',
  '--lock-wait-timeout',
  '--role',
  '--section',
  '--snapshot',
  '--rows-per-insert',
  '--include-foreign-data',
  '--table-and-children',
  '--exclude-table-and-children',
  '--exclude-table-data-and-children',
  '--sync-method',
  '--exclude-extension',
  '--restrict-key',
] as const;
const PSQL_VALUE_OPTIONS = [
  '--field-separator',
  '--pset',
  '--record-separator',
  '--table-attr',
  '--set',
  '--variable',
] as const;

export type PgDumpOptions = Readonly<{
  /** Startup budget until protocol activity; SQL and output delivery are excluded. Native hosts default to 30000 ms; browser hosts have no default limit. */
  startupTimeoutMs?: number;
  /** Ordinary PostgreSQL pg_dump arguments. Connection, file input/output, format, compression, encoding, and job flags are managed. */
  args?: readonly string[];
}>;

export type PsqlOptions = Readonly<{
  /** Startup budget until protocol activity; SQL and output delivery are excluded. Native hosts default to 30000 ms; browser hosts have no default limit. */
  startupTimeoutMs?: number;
  /** Ordinary PostgreSQL psql arguments. Connection, input, and output are managed. */
  args?: readonly string[];
  command?: string;
  script?: string;
}>;

export type ToolStreamOptions = Readonly<{
  stderr?: WritableStream<Uint8Array>;
  signal?: AbortSignal;
}>;

export type PostgresToolSummary = Readonly<{
  stdoutBytes: number;
  stderr: string;
  stderrTruncated: boolean;
}>;

export class PostgresToolError extends Error {
  readonly tool: 'pg_dump' | 'psql';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stderrTruncated: boolean;

  constructor(
    tool: 'pg_dump' | 'psql',
    message: string,
    options: {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      stderrTruncated?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PostgresToolError';
    this.tool = tool;
    this.exitCode = options.exitCode ?? null;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
    this.stderrTruncated = options.stderrTruncated ?? false;
  }
}

/** Run standard PostgreSQL plain pg_dump against an open WASIX database. */
export async function pgDump(
  database: OliphauntDatabase,
  options: PgDumpOptions = {},
): Promise<string> {
  return runTool('pg_dump', database, () => pgDumpInvocation(options));
}

function pgDumpInvocation(options: PgDumpOptions) {
  return {
    startupTimeoutMs: options.startupTimeoutMs,
    args: validatedArguments(
      'pg_dump',
      options.args,
      pgDumpManagedArgument,
      PG_DUMP_SHORT_OPTIONS,
      PG_DUMP_VALUE_OPTIONS,
    ),
  };
}

/**
 * Run standard non-interactive psql. Browsers require a `/worker` database;
 * Node.js, Bun, Deno, and Electron support root, `/direct`, and `/worker` databases.
 */
export async function psql(
  database: OliphauntDatabase,
  options: PsqlOptions = {},
): Promise<string> {
  return runTool('psql', database, () => psqlInvocation(options));
}

function psqlInvocation(options: PsqlOptions) {
  const args = validatedArguments(
    'psql',
    options.args,
    psqlManagedArgument,
    PSQL_SHORT_OPTIONS,
    PSQL_VALUE_OPTIONS,
  );
  if (options.command !== undefined && options.script !== undefined) {
    throw new TypeError('psql accepts command or script, not both');
  }
  const command = validatedInput(options.command, 'psql command');
  const script = validatedInput(options.script, 'psql script');
  if (command === undefined && script === undefined && args.length === 0) {
    throw new TypeError('psql requires non-interactive input through command, script, or args');
  }
  return { args, script, command, startupTimeoutMs: options.startupTimeoutMs };
}

/** Publish stdout create-only to a host path, including synchronous `/direct` databases. */
export async function pgDumpToFile(
  database: OliphauntDatabase,
  destination: string,
  options: PgDumpOptions = {},
): Promise<PostgresToolSummary> {
  return runToolToFile('pg_dump', database, destination, () => pgDumpInvocation(options));
}

/** Publish stdout only after psql and database-side cleanup succeed. */
export async function psqlToFile(
  database: OliphauntDatabase,
  destination: string,
  options: PsqlOptions = {},
): Promise<PostgresToolSummary> {
  return runToolToFile('psql', database, destination, () => psqlInvocation(options));
}

/** Await exact owned chunks without closing caller-owned destination streams. */
export async function pgDumpToStream(
  database: OliphauntDatabase,
  destination: WritableStream<Uint8Array>,
  options: PgDumpOptions & ToolStreamOptions = {},
): Promise<PostgresToolSummary> {
  return runToolToStream('pg_dump', database, destination, options, () =>
    pgDumpInvocation(options),
  );
}

/** Keep database ownership until output drains and tool/session cleanup completes. */
export async function psqlToStream(
  database: OliphauntDatabase,
  destination: WritableStream<Uint8Array>,
  options: PsqlOptions & ToolStreamOptions = {},
): Promise<PostgresToolSummary> {
  return runToolToStream('psql', database, destination, options, () => psqlInvocation(options));
}

type ToolInvocation = {
  startupTimeoutMs?: number;
  args: string[];
  script?: string;
  command?: string;
  outputFile?: string;
  output?: { stdout(chunk: Uint8Array): Promise<void>; stderr?(chunk: Uint8Array): Promise<void> };
};

async function runToolToStream(
  name: 'pg_dump' | 'psql',
  database: OliphauntDatabase,
  destination: WritableStream<Uint8Array>,
  options: ToolStreamOptions,
  prepare: () => ToolInvocation,
): Promise<PostgresToolSummary> {
  let stdout: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let stderr: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let failure: { cause: unknown } | undefined;
  const outputFailure = new AbortController();
  const cancel = () => {
    failure ??= { cause: options.signal!.reason };
    outputFailure.abort(failure.cause);
  };
  const write = (writer: WritableStreamDefaultWriter<Uint8Array>) => async (chunk: Uint8Array) => {
    if (failure !== undefined) throw failure.cause;
    try {
      await abortableWrite(writer.write(chunk), outputFailure.signal);
    } catch (cause) {
      failure ??= { cause };
      outputFailure.abort(failure.cause);
      throw failure.cause;
    }
  };
  try {
    const result = await runToolProcess(name, database, () => {
      const invocation = prepare();
      if (options.signal?.aborted) throw options.signal.reason;
      stdout = destination.getWriter();
      stderr = options.stderr?.getWriter();
      options.signal?.addEventListener('abort', cancel, { once: true });
      return {
        ...invocation,
        output: {
          stdout: write(stdout),
          ...(stderr === undefined ? {} : { stderr: write(stderr) }),
        },
      };
    });
    if (failure !== undefined) {
      throw new PostgresToolError(name, `${name} output destination failed`, {
        exitCode: result.exitCode,
        stderr: decodeDiagnostics(result.stderr),
        stderrTruncated: result.stderrTruncated,
        cause: failure.cause,
      });
    }
    return outputSummary(name, result);
  } catch (error) {
    if (failure !== undefined && error instanceof PostgresToolError) {
      throw new PostgresToolError(name, error.message, {
        exitCode: error.exitCode,
        stdout: error.stdout,
        stderr: error.stderr,
        stderrTruncated: error.stderrTruncated,
        cause: failure.cause,
      });
    }
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    stderr?.releaseLock();
    stdout?.releaseLock();
  }
}

function abortableWrite(write: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void write.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function runToolToFile(
  name: 'pg_dump' | 'psql',
  database: OliphauntDatabase,
  destination: string,
  prepare: () => ToolInvocation,
): Promise<PostgresToolSummary> {
  const result = await runToolProcess(name, database, () => {
    if (typeof destination !== 'string' || destination.length === 0 || destination.includes('\0')) {
      throw new TypeError('tool file destination must be a nonempty host path without NUL bytes');
    }
    return { ...prepare(), outputFile: destination };
  });
  return outputSummary(name, result);
}

function outputSummary(
  name: 'pg_dump' | 'psql',
  result: Awaited<ReturnType<typeof runWasixToolProcess>>,
): PostgresToolSummary {
  if (
    !Number.isSafeInteger(result.stdoutBytes) ||
    result.stdoutBytes! < 0 ||
    typeof result.stderrTruncated !== 'boolean'
  ) {
    throw new PostgresToolError(name, `${name} returned an invalid destination output summary`, {
      exitCode: result.exitCode,
    });
  }
  return {
    stdoutBytes: result.stdoutBytes!,
    stderr: decodeDiagnostics(result.stderr),
    stderrTruncated: result.stderrTruncated,
  };
}

async function runTool(
  name: 'pg_dump' | 'psql',
  database: OliphauntDatabase,
  prepare: () => { args: string[]; script?: string; command?: string },
): Promise<string> {
  const result = await runToolProcess(name, database, prepare);
  try {
    return decode(result.stdout, `${name} output`);
  } catch (cause) {
    throw new PostgresToolError(name, `${name} output is not valid UTF-8`, {
      exitCode: result.exitCode,
      stdout: decodeDiagnostics(result.stdout),
      stderr: decodeDiagnostics(result.stderr),
      cause,
    });
  }
}

async function runToolProcess(
  name: 'pg_dump' | 'psql',
  database: OliphauntDatabase,
  prepare: () => ToolInvocation,
) {
  const descriptor = name === 'pg_dump' ? tools.pgDump : tools.psql;
  let result: Awaited<ReturnType<typeof runWasixToolProcess>>;
  let preparationFailure: { error: unknown } | undefined;
  try {
    result = await runWasixToolProcess(database, () => {
      try {
        return { runtimeVersion: tools.runtimeVersion, tool: descriptor, ...prepare() };
      } catch (error) {
        preparationFailure = { error };
        throw error;
      }
    });
  } catch (cause) {
    if (preparationFailure?.error === cause && preparationFailure !== undefined) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'oliphauntWasixError' in cause &&
      cause.oliphauntWasixError === 'tool' &&
      'exitCode' in cause &&
      (cause.exitCode === null || Number.isSafeInteger(cause.exitCode)) &&
      'stdout' in cause &&
      cause.stdout instanceof Uint8Array &&
      'stderr' in cause &&
      cause.stderr instanceof Uint8Array
    ) {
      throw new PostgresToolError(name, detail, {
        exitCode: cause.exitCode as number | null,
        stdout: decodeDiagnostics(cause.stdout),
        stderr: decodeDiagnostics(cause.stderr),
        stderrTruncated: 'stderrTruncated' in cause && cause.stderrTruncated === true,
        cause,
      });
    }
    throw new PostgresToolError(name, `could not run ${name}: ${detail}`, { cause });
  }
  if (result.exitCode !== 0) {
    // Diagnostics are best-effort text just like native process output. Keep
    // the structured failure even if either stream contains invalid UTF-8.
    const stdout = decodeDiagnostics(result.stdout);
    const stderr = decodeDiagnostics(result.stderr);
    throw new PostgresToolError(
      name,
      `${name} exited with status ${result.exitCode}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`,
      { exitCode: result.exitCode, stdout, stderr, stderrTruncated: result.stderrTruncated },
    );
  }
  return result;
}

function validatedInput(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL bytes`);
  return value;
}

function validatedArguments(
  tool: 'pg_dump' | 'psql',
  value: readonly string[] | undefined,
  managed: (argument: string) => string | undefined,
  shortOptions: string,
  valueOptions: readonly string[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${tool} args must be an array of strings`);
  let expectsValue = false;
  const validated = value.map((argument) => {
    if (typeof argument !== 'string') throw new TypeError(`${tool} argument must be a string`);
    if (argument.includes('\0')) throw new TypeError(`${tool} argument must not contain NUL bytes`);
    if (expectsValue) {
      expectsValue = false;
      return argument;
    }
    const label = managed(argument);
    if (label !== undefined) {
      throw new TypeError(
        `${tool} argument ${JSON.stringify(argument)} conflicts with Oliphaunt's managed ${label}`,
      );
    }
    if (argument === '-' || !argument.startsWith('-')) {
      throw new TypeError(
        `${tool} argument ${JSON.stringify(argument)} conflicts with Oliphaunt's managed database or username`,
      );
    }
    expectsValue = optionConsumesNext(argument, shortOptions, valueOptions);
    return argument;
  });
  if (expectsValue) {
    throw new TypeError(`${tool} argument ${JSON.stringify(validated.at(-1))} requires a value`);
  }
  return validated;
}

function pgDumpManagedArgument(argument: string): string | undefined {
  if (argument === '--') return 'option terminator';
  return managedArgument(
    argument,
    [
      ['--password', '-W', 'password prompting'],
      ['--filter', '', 'input file'],
      ['--file', '-f', 'output file'],
      ['--format', '-F', 'output format'],
      ['--compress', '-Z', 'output compression'],
      ['--encoding', '-E', 'output encoding'],
      ['--host', '-h', 'host'],
      ['--port', '-p', 'port'],
      ['--username', '-U', 'username'],
      ['--dbname', '-d', 'database'],
      ['--jobs', '-j', 'job count'],
    ],
    PG_DUMP_SHORT_OPTIONS,
  );
}

function optionConsumesNext(
  argument: string,
  shortOptions: string,
  valueOptions: readonly string[],
): boolean {
  if (argument.startsWith('--')) {
    if (argument.includes('=')) return false;
    return valueOptions.some((option) => option.startsWith(argument));
  }
  for (let index = 1; index < argument.length; index += 1) {
    const option = argument[index];
    if (option === undefined) return false;
    const position = shortOptions.indexOf(option);
    if (position < 0) return false;
    if (shortOptions[position + 1] === ':') return index === argument.length - 1;
  }
  return false;
}

function psqlManagedArgument(argument: string): string | undefined {
  if (argument === '--') return 'option terminator';
  return managedArgument(
    argument,
    [
      ['--password', '-W', 'password prompting'],
      ['--single-step', '-s', 'interactive prompting'],
      ['--host', '-h', 'host'],
      ['--port', '-p', 'port'],
      ['--username', '-U', 'username'],
      ['--dbname', '-d', 'database'],
      ['--output', '-o', 'stdout capture'],
      ['--log-file', '-L', 'stderr capture'],
      ['--command', '-c', 'input'],
      ['--file', '-f', 'input'],
    ],
    PSQL_SHORT_OPTIONS,
  );
}

function managedArgument(
  argument: string,
  flags: readonly (readonly [long: string, short: string, label: string])[],
  shortOptions: string,
): string | undefined {
  const longName = argument.split('=', 1)[0];
  if (longName !== undefined && longName.length > 2 && longName.startsWith('--')) {
    for (const [long, , label] of flags) {
      // Native getopt_long accepts unique prefixes while PostgreSQL's bundled
      // fallback requires exact names. Reject either spelling consistently so
      // a managed option cannot become host-dependent.
      if (long.startsWith(longName)) return label;
    }
  }
  if (argument.length < 2 || argument[0] !== '-' || argument[1] === '-') {
    return undefined;
  }
  for (let index = 1; index < argument.length; index += 1) {
    const option = argument[index];
    if (option === undefined) return undefined;
    const position = shortOptions.indexOf(option);
    if (position < 0) return undefined;
    const managed = flags.find(([, short]) => short === `-${option}`);
    if (managed !== undefined) return managed[2];
    if (shortOptions[position + 1] === ':') return undefined;
  }
  return undefined;
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${label} is not valid UTF-8`, { cause });
  }
}

function decodeDiagnostics(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function assertToolsCarrier(): void {
  if (
    tools.schema !== 'oliphaunt-wasix-tools-v1' ||
    tools.product !== 'oliphaunt-wasix-tools' ||
    tools.runtimeProduct !== 'liboliphaunt-wasix' ||
    typeof tools.runtimeVersion !== 'string' ||
    tools.runtimeVersion.length === 0
  ) {
    throw new Error('@oliphaunt/liboliphaunt-wasix-tools has an invalid descriptor');
  }
}
