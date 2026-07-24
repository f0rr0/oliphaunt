import { spawnSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decode(bytes, label) {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function readBounded(file, maximum, label) {
  const size = statSync(file).size;
  if (size > maximum) {
    throw new Error(`${label} exceeded the ${maximum}-byte capture limit`);
  }
  return readFileSync(file);
}

/**
 * Capture a synchronous child's streams through regular files, never pipes.
 *
 * Bun 1.3.14 may report a successful spawnSync child before its piped stdout
 * has been completely drained. A child-owned regular file is complete when
 * waitpid returns, so inventory callers can safely inspect every emitted byte.
 * `stdoutDescriptor` is a redirection-only escape hatch for large binary
 * output: it must identify a caller-owned regular file, is never read or
 * closed here, and is intentionally outside `maxOutputBytes`.
 */
export function captureCommandBytes(
  command,
  args,
  {
    allowEmptyOutput = false,
    argv0 = undefined,
    cwd = undefined,
    env = undefined,
    gid = undefined,
    input = undefined,
    killSignal = undefined,
    label = command,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    shell = undefined,
    stdoutDescriptor = undefined,
    stdoutTerminator = undefined,
    timeout = undefined,
    uid = undefined,
    windowsHide = undefined,
    windowsVerbatimArguments = undefined,
  } = {},
) {
  if (typeof command !== "string" || command.length === 0 || !Array.isArray(args)) {
    throw new Error("command capture requires a command and argument list");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("command capture requires a positive output limit");
  }
  if (typeof allowEmptyOutput !== "boolean") {
    throw new Error("command capture allowEmptyOutput must be a Boolean");
  }
  const terminator = stdoutTerminator === undefined ? undefined : Buffer.from(stdoutTerminator);
  if (terminator !== undefined && terminator.length === 0) {
    throw new Error("command capture requires a non-empty stdout terminator");
  }
  if (allowEmptyOutput && terminator === undefined) {
    throw new Error("command capture allowEmptyOutput requires a stdout terminator");
  }
  if (
    stdoutDescriptor !== undefined
    && (!Number.isSafeInteger(stdoutDescriptor) || stdoutDescriptor < 0)
  ) {
    throw new Error("command capture stdoutDescriptor must be a non-negative file descriptor");
  }
  if (stdoutDescriptor !== undefined && terminator !== undefined) {
    throw new Error("command capture cannot frame externally redirected stdout");
  }
  if (stdoutDescriptor !== undefined && !fstatSync(stdoutDescriptor).isFile()) {
    throw new Error("command capture stdoutDescriptor must identify a regular file");
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-command-output-"));
  const stdoutFile = path.join(directory, "stdout");
  const stderrFile = path.join(directory, "stderr");
  const stdinFile = path.join(directory, "stdin");
  let stdinDescriptor;
  let capturedStdoutDescriptor;
  let stderrDescriptor;
  try {
    if (input !== undefined) {
      writeFileSync(stdinFile, input, { flag: "wx", mode: 0o600 });
      stdinDescriptor = openSync(stdinFile, "r");
    }
    if (stdoutDescriptor === undefined) {
      capturedStdoutDescriptor = openSync(stdoutFile, "wx", 0o600);
    }
    stderrDescriptor = openSync(stderrFile, "wx", 0o600);
    const result = spawnSync(command, args, {
      argv0,
      cwd,
      env,
      gid,
      killSignal,
      shell,
      stdio: [
        stdinDescriptor ?? "ignore",
        stdoutDescriptor ?? capturedStdoutDescriptor,
        stderrDescriptor,
      ],
      timeout,
      uid,
      windowsHide,
      windowsVerbatimArguments,
    });
    if (stdinDescriptor !== undefined) {
      closeSync(stdinDescriptor);
      stdinDescriptor = undefined;
    }
    if (capturedStdoutDescriptor !== undefined) {
      closeSync(capturedStdoutDescriptor);
      capturedStdoutDescriptor = undefined;
    }
    closeSync(stderrDescriptor);
    stderrDescriptor = undefined;
    // A caller-owned redirection is intentionally not captured, read, closed,
    // or bounded by maxOutputBytes. Its caller owns the regular file envelope.
    const stdoutBytes = stdoutDescriptor === undefined
      ? readBounded(stdoutFile, maxOutputBytes, `${label} stdout`)
      : Buffer.alloc(0);
    const stderrBytes = readBounded(stderrFile, maxOutputBytes, `${label} stderr`);
    if (
      terminator !== undefined
      && result.error === undefined
      && result.status === 0
      && (stdoutBytes.length === 0
        ? !allowEmptyOutput
        : !stdoutBytes.subarray(-terminator.length).equals(terminator))
    ) {
      throw new Error(`${label} stdout is missing its required terminal ${JSON.stringify(stdoutTerminator)}`);
    }
    return {
      error: result.error,
      pid: result.pid,
      signal: result.signal,
      status: result.status,
      stderr: stderrBytes,
      stdout: stdoutBytes,
    };
  } finally {
    if (stdinDescriptor !== undefined) closeSync(stdinDescriptor);
    if (capturedStdoutDescriptor !== undefined) closeSync(capturedStdoutDescriptor);
    if (stderrDescriptor !== undefined) closeSync(stderrDescriptor);
    rmSync(directory, { force: true, recursive: true });
  }
}

export function captureCommandOutput(command, args, options = {}) {
  const label = options.label ?? command;
  const result = captureCommandBytes(command, args, options);
  return {
    ...result,
    stderr: decode(result.stderr, `${label} stderr`),
    stdout: decode(result.stdout, `${label} stdout`),
  };
}
