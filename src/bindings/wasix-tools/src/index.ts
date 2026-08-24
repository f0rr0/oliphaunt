import tools from '@oliphaunt/liboliphaunt-wasix-tools';
import type { OliphauntDatabase } from '@oliphaunt/wasix-ts';
import { runWasixToolProcess } from '@oliphaunt/wasix-ts/internal/tools';

assertToolsCarrier();

const VIRTUAL_TOOL_HOST = '127.0.0.1';
const VIRTUAL_TOOL_PORT = '65432';

export type PgDumpOptions = Readonly<{
  /** Ordinary PostgreSQL pg_dump arguments. Connection, output, format, compression, encoding, and job flags are managed. */
  args?: readonly string[];
}>;

export type PsqlOptions = Readonly<{
  /** Ordinary PostgreSQL psql arguments. Connection, input, and output are managed. */
  args?: readonly string[];
  command?: string;
  script?: string;
}>;

export class PostgresToolError extends Error {
  readonly tool: 'pg_dump' | 'psql';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    tool: 'pg_dump' | 'psql',
    message: string,
    options: {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PostgresToolError';
    this.tool = tool;
    this.exitCode = options.exitCode ?? null;
    this.stdout = options.stdout ?? '';
    this.stderr = options.stderr ?? '';
  }
}

/** Run standard PostgreSQL plain pg_dump directly against an open WASIX database. */
export async function pgDump(
  database: OliphauntDatabase,
  options: PgDumpOptions = {},
): Promise<string> {
  const args = validatedArguments('pg_dump', options.args, pgDumpManagedArgument);
  const result = await runTool(
    'pg_dump',
    database,
    [
      ...args,
      '--encoding=UTF8',
      '--username=postgres',
      `--host=${VIRTUAL_TOOL_HOST}`,
      `--port=${VIRTUAL_TOOL_PORT}`,
      'postgres',
    ],
  );
  return decodeToolOutput('pg_dump', result.stdoutBytes, 'pg_dump output', result);
}

/** Run standard non-interactive psql directly against an open WASIX database. */
export async function psql(
  database: OliphauntDatabase,
  options: PsqlOptions = {},
): Promise<string> {
  const args = validatedArguments('psql', options.args, psqlManagedArgument);
  if (options.command !== undefined && options.script !== undefined) {
    throw new TypeError('psql accepts command or script, not both');
  }
  const command = validatedInput(options.command, 'psql command');
  const script = validatedInput(options.script, 'psql script');
  if (command === undefined && script === undefined && args.length === 0) {
    throw new TypeError('psql requires non-interactive input through command, script, or args');
  }
  const inputArgs =
    command !== undefined
      ? ['--command', command]
      : [];
  const result = await runTool(
    'psql',
    database,
    [
      ...args,
      '--no-psqlrc',
      '--set=ON_ERROR_STOP=1',
      '--username=postgres',
      `--host=${VIRTUAL_TOOL_HOST}`,
      `--port=${VIRTUAL_TOOL_PORT}`,
      '--dbname=postgres',
      ...inputArgs,
    ],
    script === undefined ? undefined : new TextEncoder().encode(script),
  );
  return decodeToolOutput('psql', result.stdoutBytes, 'psql output', result);
}

async function runTool(
  name: 'pg_dump' | 'psql',
  database: OliphauntDatabase,
  args: string[],
  stdin?: Uint8Array,
) {
  const descriptor = name === 'pg_dump' ? tools.pgDump : tools.psql;
  let result;
  try {
    result = await runWasixToolProcess(database, {
      runtimeVersion: tools.runtimeVersion,
      tool: descriptor,
      args,
      stdin,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PostgresToolError(name, `could not run ${name}: ${detail}`, { cause });
  }
  // Diagnostics are best-effort text just like native process output. Keep a
  // structured tool failure even if a platform diagnostic contains a byte
  // outside UTF-8; only SQL/script outputs require strict UTF-8.
  const stdout = decodeDiagnostics(result.stdout);
  const stderr = decodeDiagnostics(result.stderr);
  if (result.exitCode !== 0) {
    throw new PostgresToolError(
      name,
      `${name} exited with status ${result.exitCode}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`,
      { exitCode: result.exitCode, stdout, stderr },
    );
  }
  return { exitCode: result.exitCode, stdout, stderr, stdoutBytes: result.stdout };
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
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${tool} args must be an array of strings`);
  return value.map((argument) => {
    if (typeof argument !== 'string') throw new TypeError(`${tool} argument must be a string`);
    if (argument.includes('\0')) throw new TypeError(`${tool} argument must not contain NUL bytes`);
    const label = managed(argument);
    if (label !== undefined) {
      throw new TypeError(
        `${tool} argument ${JSON.stringify(argument)} conflicts with Oliphaunt's managed ${label}`,
      );
    }
    return argument;
  });
}

function pgDumpManagedArgument(argument: string): string | undefined {
  return managedArgument(argument, [
    ['--file', '-f', 'output file'],
    ['--format', '-F', 'output format'],
    ['--compress', '-Z', 'output compression'],
    ['--encoding', '-E', 'output encoding'],
    ['--host', '-h', 'host'],
    ['--port', '-p', 'port'],
    ['--username', '-U', 'username'],
    ['--dbname', '-d', 'database'],
    ['--jobs', '-j', 'job count'],
  ]);
}

function psqlManagedArgument(argument: string): string | undefined {
  return managedArgument(argument, [
    ['--host', '-h', 'host'],
    ['--port', '-p', 'port'],
    ['--username', '-U', 'username'],
    ['--dbname', '-d', 'database'],
    ['--output', '-o', 'stdout capture'],
    ['--log-file', '-L', 'stderr capture'],
    ['--command', '-c', 'input'],
    ['--file', '-f', 'input'],
  ]);
}

function managedArgument(
  argument: string,
  flags: readonly (readonly [long: string, short: string, label: string])[],
): string | undefined {
  for (const [long, short, label] of flags) {
    if (
      argument === long ||
      argument.startsWith(`${long}=`) ||
      argument === short ||
      (argument.startsWith(short) && argument.length > short.length)
    ) {
      return label;
    }
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

function decodeToolOutput(
  tool: 'pg_dump' | 'psql',
  bytes: Uint8Array,
  label: string,
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
): string {
  try {
    return decode(bytes, label);
  } catch (cause) {
    throw new PostgresToolError(tool, `${label} is not valid UTF-8`, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      cause,
    });
  }
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
