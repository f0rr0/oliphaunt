#!/usr/bin/env bun
// Run a command while holding the shared native runtime test lock.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const NOTICE_INTERVAL_MS = 30 * 1000;
const POLL_INTERVAL_MS = 250;
const OWNER_WRITE_GRACE_MS = 5 * 1000;
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function lockPath() {
  if (process.env.OLIPHAUNT_NATIVE_RUNTIME_LOCK_FILE) {
    return path.resolve(process.env.OLIPHAUNT_NATIVE_RUNTIME_LOCK_FILE);
  }
  return path.join(
    path.resolve(import.meta.dir, "../.."),
    "target/oliphaunt-runtime-locks/native-runtime-tests.lock",
  );
}

function timeoutSeconds() {
  const configured = process.env.OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS;
  if (!configured) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  const timeout = Number(configured);
  if (!Number.isFinite(timeout)) {
    fail("OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS must be a number", 2);
  }
  if (timeout <= 0) {
    fail("OLIPHAUNT_NATIVE_RUNTIME_LOCK_TIMEOUT_SECONDS must be greater than zero", 2);
  }
  return timeout;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metadata(command, ownerPid = process.pid) {
  const lines = [
    `pid=${ownerPid}`,
    `wrapper_pid=${process.pid}`,
    `cwd=${process.cwd()}`,
    `started_at_unix=${Math.floor(Date.now() / 1000)}`,
    `command=${command.join(" ")}`,
  ];
  if (ownerPid !== process.pid) {
    lines.push(`owner=child`);
  }
  lines.push("");
  return lines.join("\n");
}

async function readOwner(lockDir) {
  try {
    const text = await fs.readFile(path.join(lockDir, "owner"), "utf8");
    const parsed = new Map();
    for (const rawLine of text.split(/\r?\n/u)) {
      const index = rawLine.indexOf("=");
      if (index > 0) {
        parsed.set(rawLine.slice(0, index), rawLine.slice(index + 1));
      }
    }
    return { text, pid: Number(parsed.get("pid")) };
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function removeStaleLock(lockDir, lockFile) {
  const owner = await readOwner(lockDir);
  if (owner?.pid && processAlive(owner.pid)) {
    return false;
  }
  if (owner === null) {
    const stat = await fs.stat(lockDir).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs < OWNER_WRITE_GRACE_MS) {
      return false;
    }
  }
  await fs.rm(lockDir, { recursive: true, force: true });
  const label = owner?.text?.trim() ? ` stale owner: ${owner.text.trim().replace(/\n/g, "; ")}` : "";
  console.error(`removed stale native runtime test lock: ${lockFile}${label}`);
  return true;
}

async function acquireLock(lockFile, command, timeout) {
  const lockDir = `${lockFile}.lockdir`;
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  const deadline = Date.now() + timeout * 1000;
  let lastNotice = 0;
  const lockMetadata = metadata(command);

  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, "owner"), lockMetadata, "utf8");
      await fs.writeFile(lockFile, lockMetadata, "utf8");
      return { lockDir, lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await removeStaleLock(lockDir, lockFile);
      const now = Date.now();
      if (now >= deadline) {
        throw new Error(`timed out waiting for native runtime test lock after ${timeout.toFixed(0)}s: ${lockFile}`);
      }
      if (now - lastNotice >= NOTICE_INTERVAL_MS) {
        console.error(`waiting for native runtime test lock: ${lockFile}`);
        lastNotice = now;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function releaseLock(lock) {
  await fs.rm(lock.lockDir, { recursive: true, force: true });
}

function writeLockMetadata(lock, command, ownerPid) {
  const text = metadata(command, ownerPid);
  writeFileSync(path.join(lock.lockDir, "owner"), text, "utf8");
  writeFileSync(lock.lockFile, text, "utf8");
}

function signalExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}

async function runCommand(command, lock) {
  return await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    let releasing = false;
    const cleanupAndExit = async (signal) => {
      if (releasing) {
        return;
      }
      releasing = true;
      child.kill(signal);
      await releaseLock(lock);
      resolve(signalExitCode(signal));
    };
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        cleanupAndExit(signal).catch((error) => {
          console.error(`failed to release native runtime test lock: ${error.message}`);
          resolve(signalExitCode(signal));
        });
      });
    }
    child.on("error", async (error) => {
      if (releasing) {
        return;
      }
      releasing = true;
      console.error(`failed to start command ${command[0]}: ${error.message}`);
      await releaseLock(lock);
      resolve(127);
    });
    child.on("close", async (code, signal) => {
      if (releasing) {
        return;
      }
      releasing = true;
      await releaseLock(lock);
      resolve(signal ? signalExitCode(signal) : (code ?? 1));
    });
    if (child.pid) {
      try {
        writeLockMetadata(lock, command, child.pid);
      } catch (error) {
        console.error(`failed to update native runtime test lock metadata: ${error.message}`);
      }
    }
  });
}

async function main(argv) {
  if (argv.length < 1) {
    console.error("usage: tools/runtime/with-native-runtime-lock.mjs <command> [args...]");
    return 2;
  }
  const lockFile = lockPath();
  let lock;
  try {
    lock = await acquireLock(lockFile, argv, timeoutSeconds());
  } catch (error) {
    if (error?.message?.startsWith("timed out waiting for native runtime test lock")) {
      console.error(error.message);
      return 124;
    }
    throw error;
  }
  return runCommand(argv, lock);
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
