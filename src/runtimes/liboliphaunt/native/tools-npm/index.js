import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const targets = Object.freeze({
  'darwin-arm64': '@oliphaunt/tools-darwin-arm64',
  'linux-arm64': '@oliphaunt/tools-linux-arm64-gnu',
  'linux-x64': '@oliphaunt/tools-linux-x64-gnu',
  'win32-x64': '@oliphaunt/tools-win32-x64-msvc',
});

export class PostgresToolError extends Error {
  constructor(tool, message, { exitCode = null, signal = null, stdout = '', stderr = '', cause } = {}) {
    super(message, { cause });
    this.name = 'PostgresToolError';
    this.tool = tool;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export async function pgDump(connectionString, options = {}) {
  validateConnectionString(connectionString);
  const args = validatedArguments('pg_dump', options.args, pgDumpManagedArgument);
  return runTool('pg_dump', [
    ...args,
    '--encoding=UTF8',
    '--dbname',
    connectionString,
  ]);
}

export async function psql(connectionString, options = {}) {
  validateConnectionString(connectionString);
  const args = validatedArguments('psql', options.args, psqlManagedArgument);
  if (options.command !== undefined && options.script !== undefined) {
    throw new TypeError('psql accepts command or script, not both');
  }
  const command = validatedInput(options.command, 'psql command');
  const script = validatedInput(options.script, 'psql script');
  if (command === undefined && script === undefined && args.length === 0) {
    throw new TypeError('psql requires non-interactive input through command, script, or args');
  }
  const inputArgs = command === undefined ? [] : ['--command', command];
  return runTool(
    'psql',
    [...args, '-X', '--set', 'ON_ERROR_STOP=1', '--dbname', connectionString, ...inputArgs],
    script,
  );
}

function validateConnectionString(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('PostgreSQL connection string must be a non-empty string');
  }
  if (value.includes('\0')) throw new TypeError('PostgreSQL connection string must not contain NUL bytes');
}

function validatedInput(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL bytes`);
  return value;
}

function validatedArguments(tool, value, managed) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${tool} args must be an array of strings`);
  return value.map((argument) => {
    if (typeof argument !== 'string') throw new TypeError(`${tool} argument must be a string`);
    if (argument.includes('\0')) throw new TypeError(`${tool} argument must not contain NUL bytes`);
    const label = managed(argument);
    if (label !== undefined) {
      throw new TypeError(`${tool} argument ${JSON.stringify(argument)} conflicts with Oliphaunt's managed ${label}`);
    }
    return argument;
  });
}

function pgDumpManagedArgument(argument) {
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

function psqlManagedArgument(argument) {
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

function managedArgument(argument, flags) {
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

async function runTool(tool, args, stdin) {
  let executable;
  let environment;
  try {
    const runtime = resolveRuntime();
    executable = path.join(
      runtime,
      'bin',
      process.platform === 'win32' ? `${tool}.exe` : tool,
    );
    environment = toolEnvironment(runtime);
  } catch (cause) {
    throw new PostgresToolError(tool, `could not locate ${tool}`, { cause });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdinFailure;
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
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (cause) => {
      rejectOnce(new PostgresToolError(tool, `could not run ${tool}`, { cause }));
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      const stdoutBytes = Buffer.concat(stdout);
      const stdoutText = decodeDiagnostics(stdoutBytes);
      const stderrText = decodeDiagnostics(Buffer.concat(stderr));
      if (exitCode !== 0 || signal !== null) {
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
        reject(new PostgresToolError(tool, `could not write to ${tool}`, { cause: stdinFailure }));
        return;
      }
      try {
        resolve(new TextDecoder('utf-8', { fatal: true }).decode(stdoutBytes));
      } catch (cause) {
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
    });
    child.stdin.once('error', (cause) => {
      stdinFailure = cause;
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin, 'utf8');
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
    environment.DYLD_LIBRARY_PATH = [lib, environment.DYLD_LIBRARY_PATH].filter(Boolean).join(separator);
  } else if (process.platform === 'linux') {
    environment.LD_LIBRARY_PATH = [lib, environment.LD_LIBRARY_PATH].filter(Boolean).join(separator);
  }
  const icu = path.join(runtime, 'share', 'icu');
  environment.ICU_DATA ??= icu;
  return environment;
}

function decodeDiagnostics(bytes) {
  return new TextDecoder().decode(bytes);
}
