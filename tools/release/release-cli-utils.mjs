import { spawnSync } from "node:child_process";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "../..");

export function uniqueValueFlag(args, flag) {
  let found = false;
  let selected = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== flag && !argument.startsWith(`${flag}=`)) continue;
    if (found) {
      throw new Error(`${flag} must be provided at most once`);
    }
    found = true;
    if (argument === flag) {
      if (index + 1 >= args.length) {
        throw new Error(`${flag} requires a value`);
      }
      const next = args[index + 1];
      if (next === flag || next.startsWith(`${flag}=`)) {
        throw new Error(`${flag} must be provided at most once`);
      }
      selected = next;
      index += 1;
    } else {
      selected = argument.slice(flag.length + 1);
    }
  }
  return selected;
}

export function fail(tool, message, exitCode = 1) {
  console.error(`${tool}: ${message}`);
  process.exit(exitCode);
}

export function run(
  tool,
  args,
  {
    failExitCode = 1,
    cwd = ROOT,
    environment = undefined,
    timeout = undefined,
  } = {},
) {
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env: environment,
    stdio: "inherit",
    timeout,
  });
  if (result.error) {
    const context = result.error.code === "ETIMEDOUT" ? "timed out" : "failed to start";
    fail(tool, `${args[0]} ${context}: ${result.error.message}`, failExitCode);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Run a synchronous CLI command without terminating the current process.
 *
 * Publication executors use this variant inside concurrent registry lanes so
 * a peer failure remains an ordinary rejection. That lets the executor drain
 * mutations already in flight and run mandatory credential cleanup before its
 * top-level caller chooses the process exit status.
 */
export function runOrThrow(tool, args, { cwd = ROOT, timeout = undefined } = {}) {
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    stdio: "inherit",
    timeout,
  });
  if (result.error) {
    const context = result.error.code === "ETIMEDOUT" ? "timed out" : "failed to start";
    throw new Error(`${tool}: ${args[0]} ${context}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${tool}: ${args[0]} exited with ${result.signal == null ? `status ${String(result.status)}` : `signal ${result.signal}`}`,
    );
  }
}
