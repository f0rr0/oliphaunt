import { spawnSync } from "node:child_process";
import process from "node:process";

export function fail(prefix, message) {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

export function repoRoot(prefix) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.error) {
    fail(prefix, result.error.message);
  }
  if (result.status !== 0 || !result.stdout.trim()) {
    fail(prefix, "must run inside the Oliphaunt git checkout");
  }
  return result.stdout.trim();
}

export function chdirRepoRoot(prefix) {
  process.chdir(repoRoot(prefix));
}

export function run(prefix, command, args, { announce = false } = {}) {
  if (announce) {
    console.log(`\n==> ${[command, ...args].join(" ")}`);
  }
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    fail(prefix, result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
