import { spawnSync } from "node:child_process";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "../..");

export function fail(tool, message, exitCode = 1) {
  console.error(`${tool}: ${message}`);
  process.exit(exitCode);
}

export function run(tool, args, { failExitCode = 1 } = {}) {
  console.log(`\n==> ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    fail(tool, `${args[0]} failed to start: ${result.error.message}`, failExitCode);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
