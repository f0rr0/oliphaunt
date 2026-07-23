#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const POLL_MS = 25;
const TERM_GRACE_MS = 750;
const KILL_GRACE_MS = 2_000;

function fail(message) {
  throw new Error(`exact-candidate-command-watchdog.mjs: ${message}`);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} is required`);
  return value;
}

const [, , resultPath, pidPath] = process.argv;
requiredString(resultPath, "result path");
requiredString(pidPath, "PID path");

function writeAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, destination);
}

function emit(value) {
  writeAtomic(resultPath, `${JSON.stringify({ schemaVersion: 1, ...value })}\n`);
}

function errorEvidence(cause) {
  return {
    name: cause instanceof Error ? cause.name : "Error",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (cause) {
    if (cause?.code === "ESRCH") return false;
    if (cause?.code === "EPERM") return true;
    throw cause;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(exists, graceMs) {
  const attempts = Math.ceil(graceMs / POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!exists()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !exists();
}

async function terminateTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/pid", String(pid), "/t", "/f"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    );
    if (result.error !== undefined || result.status !== 0 || processExists(pid)) {
      const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
      fail(`could not verify Windows process-tree termination for ${pid}${detail ? `: ${detail}` : ""}`);
    }
    return {
      pid,
      platform: process.platform,
      strategy: "taskkill-tree",
      terminated: true,
    };
  }

  const exists = () => groupExists(pid);
  if (!exists() && processExists(pid)) {
    fail(`live POSIX child ${pid} does not own the promised process group`);
  }
  let termSent = false;
  let killSent = false;
  if (exists()) {
    try {
      process.kill(-pid, "SIGTERM");
      termSent = true;
    } catch (cause) {
      if (cause?.code !== "ESRCH") throw cause;
    }
  }
  if (!await waitUntilGone(exists, TERM_GRACE_MS)) {
    try {
      process.kill(-pid, "SIGKILL");
      killSent = true;
    } catch (cause) {
      if (cause?.code !== "ESRCH") throw cause;
    }
  }
  if (!await waitUntilGone(exists, KILL_GRACE_MS) || processExists(pid)) {
    fail(`POSIX process group ${pid} survived SIGTERM and SIGKILL`);
  }
  return {
    pid,
    platform: process.platform,
    strategy: "posix-process-group",
    termSent,
    killSent,
    terminated: true,
  };
}

const request = JSON.parse(readFileSync(0, "utf8"));
requiredString(request.command, "command");
requiredString(request.cwd, "cwd");
if (!Array.isArray(request.args) || request.args.some((value) => typeof value !== "string")) {
  fail("args must be a string array");
}
if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
  fail("timeoutMs must be a positive safe integer");
}
if (!Number.isSafeInteger(request.captureLimitBytes) || request.captureLimitBytes <= 0) {
  fail("captureLimitBytes must be a positive safe integer");
}
if (!["capture", "file", "inherit"].includes(request.stdio)) fail("stdio mode is invalid");

let finalized = false;
let terminating = false;
let forwardedBytes = 0;
const child = spawn(request.command, request.args, {
  cwd: request.cwd,
  detached: process.platform !== "win32",
  env: process.env,
  stdio: request.stdio === "capture"
    ? ["ignore", "pipe", "pipe"]
    : request.stdio === "file"
      ? ["ignore", "inherit", "pipe"]
      : ["ignore", "inherit", "inherit"],
  windowsVerbatimArguments: request.windowsVerbatimArguments === true,
});

async function terminateAndFinish(state, detail = {}) {
  if (finalized || terminating) return;
  terminating = true;
  let processTree;
  try {
    processTree = await terminateTree(child.pid);
  } catch (cause) {
    processTree = {
      pid: child.pid,
      platform: process.platform,
      strategy: process.platform === "win32" ? "taskkill-tree" : "posix-process-group",
      terminated: false,
      error: errorEvidence(cause),
    };
  }
  finalized = true;
  emit({ state, pid: child.pid, processTree, ...detail });
  process.exitCode = state === "timed-out" ? 124 : 125;
}

function forwardBounded(destination, chunk) {
  if (finalized || terminating) return;
  const buffer = Buffer.from(chunk);
  const remaining = request.captureLimitBytes - forwardedBytes;
  if (remaining > 0) {
    const forwarded = buffer.subarray(0, Math.min(buffer.length, remaining));
    destination.write(forwarded);
    forwardedBytes += forwarded.length;
  }
  if (buffer.length > remaining) {
    void terminateAndFinish("output-limit", {
      error: {
        name: "ExactCandidateCommandOutputLimitError",
        message: `command output exceeded ${request.captureLimitBytes} bytes`,
      },
      outputLimitBytes: request.captureLimitBytes,
    });
  }
}

if (child.stdout !== null) child.stdout.on("data", (chunk) => forwardBounded(process.stdout, chunk));
if (child.stderr !== null) child.stderr.on("data", (chunk) => forwardBounded(process.stderr, chunk));
child.once("error", (cause) => {
  if (finalized || terminating) return;
  finalized = true;
  emit({ state: "spawn-failed", error: errorEvidence(cause) });
  process.exitCode = 125;
});
child.once("spawn", () => {
  writeAtomic(pidPath, `${child.pid}\n`);
});
child.once("close", (status, signal) => {
  if (finalized || terminating) return;
  finalized = true;
  emit({ state: "exited", pid: child.pid, signal, status });
  process.exitCode = status ?? 1;
});

setTimeout(() => {
  void terminateAndFinish("timed-out", { timeoutMs: request.timeoutMs });
}, request.timeoutMs).unref();

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (cause) => {
    void terminateAndFinish("supervisor-failed", { error: errorEvidence(cause) });
  });
}
