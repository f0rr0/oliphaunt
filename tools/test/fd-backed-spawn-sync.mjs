import { spawnSync as nativeSpawnSync } from "node:child_process";

import { captureCommandBytes } from "../dev/capture-command-output.mjs";

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const SUPPORTED_CAPTURE_OPTIONS = new Set([
  "argv0",
  "cwd",
  "encoding",
  "env",
  "gid",
  "input",
  "killSignal",
  "maxBuffer",
  "shell",
  "stdio",
  "timeout",
  "uid",
  "windowsHide",
  "windowsVerbatimArguments",
]);

function fail(message) {
  throw new Error(`fd-backed-spawn-sync: ${message}`);
}

function invocation(command, argsOrOptions, maybeOptions) {
  if (typeof command !== "string" || command.length === 0) {
    fail("command must be a non-empty string");
  }
  if (Array.isArray(argsOrOptions)) {
    return { args: argsOrOptions, options: maybeOptions ?? {} };
  }
  if (argsOrOptions === undefined || argsOrOptions === null) {
    return { args: [], options: maybeOptions ?? {} };
  }
  if (typeof argsOrOptions === "object" && maybeOptions === undefined) {
    return { args: [], options: argsOrOptions };
  }
  fail("arguments must be an array followed by an optional options object");
}

function stdioModes(stdio) {
  if (stdio === undefined || stdio === null || stdio === "pipe") {
    return ["pipe", "pipe", "pipe"];
  }
  if (stdio === "ignore" || stdio === "inherit") {
    return [stdio, stdio, stdio];
  }
  if (!Array.isArray(stdio) || stdio.length < 3) {
    fail("stdio must be pipe, ignore, inherit, or an array with stdin/stdout/stderr entries");
  }
  return stdio.slice(0, 3).map((mode) => mode ?? "pipe");
}

function isPipe(mode) {
  return mode === "pipe";
}

function safelyClosedOutput(mode) {
  return mode === "ignore"
    || mode === "inherit"
    || (Number.isSafeInteger(mode) && mode >= 0)
    || (mode !== null && typeof mode === "object");
}

function encoded(bytes, encoding) {
  if (encoding === undefined || encoding === null || encoding === "buffer") {
    return Buffer.from(bytes);
  }
  if (typeof encoding !== "string" || !Buffer.isEncoding(encoding)) {
    fail(`unsupported output encoding ${JSON.stringify(encoding)}`);
  }
  return Buffer.from(bytes).toString(encoding);
}

function boundedMaxBuffer(value) {
  const result = value ?? DEFAULT_MAX_BUFFER_BYTES;
  if (!Number.isSafeInteger(result) || result <= 0) {
    fail("maxBuffer must be a positive safe integer");
  }
  return result;
}

function throwResult(command, args, result) {
  if (result.error !== undefined) throw result.error;
  const stderr = typeof result.stderr === "string"
    ? result.stderr
    : Buffer.from(result.stderr ?? []).toString("utf8");
  const detail = stderr.trim();
  const error = new Error(
    `Command failed: ${command}${args.length === 0 ? "" : ` ${args.join(" ")}`}`
      + (detail ? `\n${detail}` : ""),
  );
  Object.assign(error, {
    code: result.status,
    output: result.output,
    pid: result.pid,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  });
  throw error;
}

/**
 * Test-only synchronous child facade.
 *
 * Bun 1.3.14 can return from a successful synchronous child before a piped
 * stdout/stderr stream has been completely drained. Tests need Node's familiar
 * result shape, so capture both output streams through regular files and
 * reconstruct that shape after the child has exited. Calls whose output is
 * explicitly inherited, ignored, or redirected to caller-owned descriptors do
 * not create a pipe and are delegated unchanged.
 */
export function spawnSync(command, argsOrOptions, maybeOptions) {
  const { args, options } = invocation(command, argsOrOptions, maybeOptions);
  if (options === null || Array.isArray(options) || typeof options !== "object") {
    fail("options must be an object");
  }
  const modes = stdioModes(options.stdio);
  const capturesStdout = isPipe(modes[1]);
  const capturesStderr = isPipe(modes[2]);
  if (!capturesStdout && !capturesStderr) {
    if (!safelyClosedOutput(modes[1]) || !safelyClosedOutput(modes[2])) {
      fail("delegated stdout and stderr must be inherited, ignored, or explicitly redirected");
    }
    return nativeSpawnSync(command, args, options);
  }
  if (!capturesStdout || !capturesStderr) {
    fail("mixed captured and delegated stdout/stderr is unsupported");
  }
  if (!["pipe", "ignore"].includes(modes[0])) {
    fail("captured calls require piped or ignored stdin");
  }
  if (options.input !== undefined && modes[0] !== "pipe") {
    fail("input requires piped stdin");
  }
  const unsupported = Object.keys(options).filter((key) => !SUPPORTED_CAPTURE_OPTIONS.has(key));
  if (unsupported.length > 0) {
    fail(`captured call uses unsupported options: ${unsupported.sort().join(",")}`);
  }
  const result = captureCommandBytes(command, args, {
    argv0: options.argv0,
    cwd: options.cwd,
    env: options.env,
    gid: options.gid,
    input: options.input,
    killSignal: options.killSignal,
    label: command,
    maxOutputBytes: boundedMaxBuffer(options.maxBuffer),
    shell: options.shell,
    timeout: options.timeout,
    uid: options.uid,
    windowsHide: options.windowsHide,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
  });
  const stdout = encoded(result.stdout, options.encoding);
  const stderr = encoded(result.stderr, options.encoding);
  return {
    error: result.error,
    output: [null, stdout, stderr],
    pid: result.pid,
    signal: result.signal,
    status: result.status,
    stderr,
    stdout,
  };
}

export function execFileSync(command, argsOrOptions, maybeOptions) {
  const { args, options } = invocation(command, argsOrOptions, maybeOptions);
  const result = spawnSync(command, args, options);
  if (result.error !== undefined || result.status !== 0) {
    throwResult(command, args, result);
  }
  return result.stdout;
}

export function execSync(command, options = {}) {
  if (typeof command !== "string" || command.length === 0) {
    fail("execSync command must be a non-empty string");
  }
  const result = spawnSync(command, [], { ...options, shell: options.shell ?? true });
  if (result.error !== undefined || result.status !== 0) {
    throwResult(command, [], result);
  }
  return result.stdout;
}
