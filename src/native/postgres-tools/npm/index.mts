import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createCapturedOutput, captureOutput, finishCapture } from './output-capture.mjs';
import { writeNewFile } from './output-file.mjs';

const require = createRequire(import.meta.url);
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
];
const PSQL_VALUE_OPTIONS = [
  '--field-separator',
  '--pset',
  '--record-separator',
  '--table-attr',
  '--set',
  '--variable',
];

const targets = Object.freeze({
  'darwin-arm64': '@oliphaunt/tools-darwin-arm64',
  'linux-arm64': '@oliphaunt/tools-linux-arm64-gnu',
  'linux-x64': '@oliphaunt/tools-linux-x64-gnu',
  'win32-x64': '@oliphaunt/tools-win32-x64-msvc',
});

export class PostgresToolError extends Error {
  constructor(
    tool,
    message,
    {
      exitCode = null,
      signal = null,
      stdout = '',
      stderr = '',
      stderrTruncated = false,
      cause,
    } = {},
  ) {
    super(message, { cause });
    this.name = 'PostgresToolError';
    this.tool = tool;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stderrTruncated = stderrTruncated;
  }
}

export async function pgDump(connectionString, options = {}) {
  return runTool('pg_dump', pgDumpInvocation(connectionString, options));
}

export async function pgDumpToStream(connectionString, destination, options = {}) {
  validateDestination(destination);
  return runTool(
    'pg_dump',
    pgDumpInvocation(connectionString, options),
    undefined,
    destination,
    options.stderr,
    options.signal,
  );
}

export async function pgDumpToFile(connectionString, destination, options = {}) {
  const args = pgDumpInvocation(connectionString, options);
  return runToolToFile('pg_dump', args, undefined, destination, options);
}

function pgDumpInvocation(connectionString, options) {
  validateConnectionString(connectionString);
  const args = validatedArguments(
    'pg_dump',
    options.args,
    pgDumpManagedArgument,
    PG_DUMP_SHORT_OPTIONS,
    PG_DUMP_VALUE_OPTIONS,
  );
  return [...args, '--encoding=UTF8', '--no-password', '--dbname', connectionString];
}

export async function psql(connectionString, options = {}) {
  const { args, stdin } = psqlInvocation(connectionString, options);
  return runTool('psql', args, stdin);
}

export async function psqlToStream(connectionString, destination, options = {}) {
  validateDestination(destination);
  const { args, stdin } = psqlInvocation(connectionString, options);
  return runTool('psql', args, stdin, destination, options.stderr, options.signal);
}

export async function psqlToFile(connectionString, destination, options = {}) {
  const { args, stdin } = psqlInvocation(connectionString, options);
  return runToolToFile('psql', args, stdin, destination, options);
}

function psqlInvocation(connectionString, options) {
  validateConnectionString(connectionString);
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
  const inputArgs =
    command !== undefined ? ['--command', command] : script !== undefined ? ['--file=-'] : [];
  return {
    args: [
      ...args,
      '--no-psqlrc',
      '--no-password',
      '--set=ON_ERROR_STOP=1',
      '--dbname',
      connectionString,
      ...inputArgs,
    ],
    stdin: script,
  };
}

function validateConnectionString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('PostgreSQL connection string must be a non-empty string');
  }
  if (value.includes('\0'))
    throw new TypeError('PostgreSQL connection string must not contain NUL bytes');
}

function validatedInput(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL bytes`);
  return value;
}

function validatedArguments(tool, value, managed, shortOptions, valueOptions) {
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

function pgDumpManagedArgument(argument) {
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

function optionConsumesNext(argument, shortOptions, valueOptions) {
  if (argument.startsWith('--')) {
    if (argument.includes('=')) return false;
    return valueOptions.some((option) => option.startsWith(argument));
  }
  for (let index = 1; index < argument.length; index += 1) {
    const option = argument[index];
    const position = shortOptions.indexOf(option);
    if (position < 0) return false;
    if (shortOptions[position + 1] === ':') return index === argument.length - 1;
  }
  return false;
}

function psqlManagedArgument(argument) {
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

function managedArgument(argument, flags, shortOptions) {
  const [longName] = argument.split('=', 1);
  if (longName.length > 2 && longName.startsWith('--')) {
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
    const position = shortOptions.indexOf(option);
    if (position < 0) return undefined;
    const managed = flags.find(([, short]) => short === `-${option}`);
    if (managed !== undefined) return managed[2];
    if (shortOptions[position + 1] === ':') return undefined;
  }
  return undefined;
}

function validateDestination(destination) {
  if (destination === null || typeof destination?.getWriter !== 'function') {
    throw new TypeError('output destination must be a WritableStream<Uint8Array>');
  }
}

async function runToolToFile(tool, args, stdin, destination, options) {
  let completed;
  try {
    return await writeNewFile(destination, async (stream) => {
      completed = await runTool(tool, args, stdin, stream, options.stderr, options.signal);
      return completed;
    });
  } catch (cause) {
    if (cause instanceof PostgresToolError || cause instanceof TypeError) throw cause;
    throw new PostgresToolError(
      tool,
      `could not publish ${tool} output: ${cause?.message ?? cause}`,
      {
        exitCode: completed === undefined ? null : 0,
        stderr: completed?.stderr,
        stderrTruncated: completed?.stderrTruncated,
        cause,
      },
    );
  }
}

async function runTool(tool, args, stdin, destination, diagnostics, signal) {
  signal?.throwIfAborted();
  const stdoutWriter = destination?.getWriter();
  let stderrWriter;
  try {
    if (diagnostics !== undefined) {
      validateDestination(diagnostics);
      stderrWriter = diagnostics.getWriter();
    }
    return await runToolOwned(tool, args, stdin, stdoutWriter, stderrWriter, signal);
  } finally {
    stderrWriter?.releaseLock();
    stdoutWriter?.releaseLock();
  }
}

async function runToolOwned(tool, args, stdin, stdoutWriter, stderrWriter, abortSignal) {
  let executable;
  let environment;
  try {
    const runtime = resolveRuntime();
    executable = path.join(runtime, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool);
    environment = toolEnvironment(runtime);
  } catch (cause) {
    throw new PostgresToolError(tool, `could not locate ${tool}`, { cause });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdinFailure;
    let processFailure;
    let killTimer;
    const outputFailure = new AbortController();
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let child;
    try {
      child = spawn(executable, args, {
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      rejectOnce(new PostgresToolError(tool, `could not start ${tool}`, { cause }));
      return;
    }
    const cancel = () => {
      processFailure = { cause: abortSignal.reason };
      outputFailure.abort(abortSignal.reason);
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer.unref?.();
    };
    abortSignal?.addEventListener('abort', cancel, { once: true });
    if (abortSignal?.aborted) cancel();
    const captured = createCapturedOutput(stdoutWriter !== undefined);
    let drains;
    if (stdoutWriter === undefined) {
      child.stdout.on('data', (chunk) => captureOutput(captured, 'stdout', chunk));
      child.stderr.on('data', (chunk) => captureOutput(captured, 'stderr', chunk));
      drains = Promise.resolve([]);
    } else {
      // Each write's Promise owns producer credit. Readable buffering and OS
      // pipes provide bounded backpressure while the destination is stalled.
      drains = Promise.all(
        [
          drainDestination(child.stdout, stdoutWriter, undefined, outputFailure),
          drainDestination(
            child.stderr,
            stderrWriter,
            (chunk) => captureOutput(captured, 'stderr', chunk),
            outputFailure,
          ),
        ].map((drain) => drain.catch((cause) => ({ failure: { cause } }))),
      );
    }
    child.once('error', (cause) => {
      if (stdoutWriter === undefined)
        rejectOnce(new PostgresToolError(tool, `could not run ${tool}`, { cause }));
      else processFailure = { cause };
    });
    child.once('close', async (exitCode, signal) => {
      clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', cancel);
      if (settled) return;
      settled = true;
      try {
        const drained = await drains;
        const { stdout: stdoutBytes, stderr: stderrBytes } = finishCapture(captured);
        if (stdoutWriter !== undefined) {
          const failures = [processFailure, ...drained.map((result) => result.failure)].filter(
            (failure) => failure !== undefined,
          );
          if (stdinFailure !== undefined) failures.push({ cause: stdinFailure });
          const stderr = decodeDiagnostics(stderrBytes);
          const stderrTruncated = captured.stderrTruncated;
          if (failures.length !== 0 || exitCode !== 0 || signal !== null) {
            reject(
              new PostgresToolError(
                tool,
                `${tool} destination invocation failed${exitCode === null ? '' : ` with status ${exitCode}`}`,
                {
                  exitCode,
                  signal,
                  stderr,
                  stderrTruncated,
                  cause:
                    failures.length > 1
                      ? new AggregateError(
                          failures.map((failure) => failure.cause),
                          'tool output failures',
                        )
                      : failures[0]?.cause,
                },
              ),
            );
            return;
          }
          resolve({ stdoutBytes: drained[0].bytes, stderr, stderrTruncated });
          return;
        }
        if (exitCode !== 0 || signal !== null) {
          const stdoutText = decodeDiagnostics(stdoutBytes);
          const stderrText = decodeDiagnostics(stderrBytes);
          reject(
            new PostgresToolError(
              tool,
              `${tool} ${signal === null ? `exited with status ${exitCode}` : `was terminated by ${signal}`}${stderrText.trim().length === 0 ? '' : `: ${stderrText.trim()}`}`,
              { exitCode, signal, stdout: stdoutText, stderr: stderrText },
            ),
          );
          return;
        }
        if (stdinFailure !== undefined) {
          reject(
            new PostgresToolError(tool, `could not write to ${tool}`, {
              exitCode,
              signal,
              stdout: decodeDiagnostics(stdoutBytes),
              stderr: decodeDiagnostics(stderrBytes),
              cause: stdinFailure,
            }),
          );
          return;
        }
        try {
          resolve(new TextDecoder('utf-8', { fatal: true }).decode(stdoutBytes));
        } catch (cause) {
          const stdoutText = decodeDiagnostics(stdoutBytes);
          const stderrText = decodeDiagnostics(stderrBytes);
          reject(
            new PostgresToolError(tool, `${tool} produced non-UTF-8 output`, {
              exitCode,
              signal,
              stdout: stdoutText,
              stderr: stderrText,
              cause,
            }),
          );
        }
      } catch (cause) {
        // Buffer concatenation and JS string conversion have their own host
        // size limits. Reject the invocation, not the event-loop callback.
        reject(
          new PostgresToolError(tool, `${tool} output capture failed`, {
            exitCode,
            signal,
            cause,
          }),
        );
      }
    });
    child.stdin.once('error', (cause) => {
      stdinFailure = cause;
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin, 'utf8');
  });
}

async function drainDestination(readable, writer, capture, outputFailure) {
  let bytes = 0;
  let failure;
  for await (const chunk of readable) {
    for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
      const part = chunk.subarray(offset, offset + 64 * 1024);
      capture?.(part);
      if (failure !== undefined || writer === undefined) continue;
      try {
        // Give the sink an owned chunk; it may retain or mutate it after write.
        await writeWithSignal(writer, Uint8Array.from(part), outputFailure.signal);
        bytes += part.length;
      } catch (cause) {
        failure = { cause };
        outputFailure.abort(cause);
      }
    }
  }
  return { bytes, failure };
}

function writeWithSignal(writer, chunk, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => writer.write(chunk))
      .then(
        () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        (cause) => {
          signal.removeEventListener('abort', abort);
          reject(cause);
        },
      );
  });
}

function resolveRuntime() {
  const key = `${process.platform}-${process.arch}`;
  const packageName = targets[key];
  if (packageName === undefined) {
    throw new Error(`@oliphaunt/tools does not support ${process.platform}/${process.arch}`);
  }
  let manifest;
  try {
    manifest = require.resolve(`${packageName}/package.json`);
  } catch (cause) {
    throw new Error(`the compatible optional package ${packageName} is not installed`, { cause });
  }
  return path.join(path.dirname(manifest), 'runtime');
}

function toolEnvironment(runtime) {
  const environment = {
    ...process.env,
    PGCLIENTENCODING: 'UTF8',
    PGSSLMODE: process.env.PGSSLMODE ?? 'disable',
  };
  const bin = path.join(runtime, 'bin');
  const lib = path.join(runtime, 'lib');
  const separator = path.delimiter;
  environment.PATH = [bin, environment.PATH].filter(Boolean).join(separator);
  if (process.platform === 'darwin') {
    environment.DYLD_LIBRARY_PATH = [lib, environment.DYLD_LIBRARY_PATH]
      .filter(Boolean)
      .join(separator);
  } else if (process.platform === 'linux') {
    environment.LD_LIBRARY_PATH = [lib, environment.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(separator);
  }
  const icu = path.join(runtime, 'share', 'icu');
  environment.ICU_DATA ??= icu;
  return environment;
}

function decodeDiagnostics(bytes) {
  return new TextDecoder().decode(bytes);
}
