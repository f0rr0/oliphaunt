#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electron = process.env.OLIPHAUNT_E2E_ELECTRON;
const appDir = process.env.OLIPHAUNT_E2E_ELECTRON_APP;
if (!electron || !appDir) {
  throw new Error("OLIPHAUNT_E2E_ELECTRON and OLIPHAUNT_E2E_ELECTRON_APP are required");
}

const userData = mkdtempSync(join(tmpdir(), "oliphaunt-electron-e2e-"));
const child = spawn(
  electron,
  [
    "--no-sandbox",
    `--user-data-dir=${userData}`,
    "dist/main/main-process.js",
  ],
  {
    cwd: appDir,
    env: {
      ...process.env,
      OLIPHAUNT_ELECTRON_E2E_DRIVER: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);

let nextId = 1;
let driverReady = false;
const pending = new Map();

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.event && process.env.OLIPHAUNT_E2E_DEBUG) {
    console.error(`electron event ${JSON.stringify(message)}`);
  }
  if (message.event === "driver-ready") {
    driverReady = true;
    pending.get(0)?.resolve("driver-ready");
    pending.delete(0);
    return;
  }
  const id = message.id;
  if (typeof id !== "number") return;
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (message.ok) {
    request.resolve(message.value);
  } else {
    request.reject(new Error(message.error || `Electron driver command ${id} failed`));
  }
});

try {
  await waitForDriverReady();
  await rpc("ready", 30_000);
  await rpc("runTodoSmoke", 150_000);
  console.log("electron driver todo smoke passed");
  await rpc("shutdown", 30_000).catch(() => undefined);
  await waitForExit(10_000);
} finally {
  await stopChild();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}

function waitForDriverReady() {
  if (driverReady) return Promise.resolve("driver-ready");
  return withTimeout(
    new Promise((resolve, reject) => {
      pending.set(0, { resolve, reject });
      child.once("exit", (code, signal) => {
        pending.delete(0);
        reject(new Error(`Electron exited before driver was ready: ${code ?? signal}`));
      });
    }),
    30_000,
    "timed out waiting for Electron test driver",
  );
}

function rpc(command, timeoutMs) {
  if (!child.connected) {
    throw new Error("Electron IPC channel is not connected");
  }
  const id = nextId++;
  const result = withTimeout(
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    }),
    timeoutMs,
    `timed out waiting for Electron driver command ${command}`,
  ).finally(() => pending.delete(id));
  child.send({ id, command });
  return result;
}

function waitForExit(timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withTimeout(
    new Promise((resolve) => child.once("exit", resolve)),
    timeoutMs,
    "timed out waiting for Electron to exit",
  );
}

async function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(3_000);
  } catch {
    child.kill("SIGKILL");
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
