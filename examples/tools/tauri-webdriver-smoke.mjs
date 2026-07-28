#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const driverPath = process.env.OLIPHAUNT_E2E_TAURI_DRIVER;
const application = process.env.OLIPHAUNT_E2E_TAURI_APP;

if (!driverPath || !application) {
  throw new Error("OLIPHAUNT_E2E_TAURI_DRIVER and OLIPHAUNT_E2E_TAURI_APP are required");
}

const webdriverElement = "element-6066-11e4-a52e-4f735466cecf";
const port = await freePort();
const nativePort = await freePort();
const appData = mkdtempSync(join(tmpdir(), "oliphaunt-tauri-e2e-"));
let driver;
let sessionId;

try {
  driver = spawn(driverPath, ["--port", String(port), "--native-port", String(nativePort)], {
    env: {
      ...process.env,
      XDG_DATA_HOME: appData,
      XDG_CONFIG_HOME: appData,
      XDG_CACHE_HOME: appData,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  driver.stdout.on("data", (chunk) => process.stdout.write(chunk));
  driver.stderr.on("data", (chunk) => process.stderr.write(chunk));

  await waitForDriver(port);
  const session = await request(port, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application },
      },
    },
  });
  sessionId = session.sessionId ?? session.value?.sessionId;
  if (!sessionId) {
    throw new Error(`session response did not include sessionId: ${JSON.stringify(session)}`);
  }

  await setValue(port, sessionId, "#title", `Ship Tauri e2e ${Date.now()}`);
  await setValue(port, sessionId, "#notes", "created by raw WebDriver");
  await setValue(port, sessionId, "#area", "examples");
  await setValue(port, sessionId, "#context", "local registry");
  await click(port, sessionId, "button[type='submit']");
  await waitForText(port, sessionId, "article.todo", "created by raw WebDriver", 60_000);
  await click(port, sessionId, "article.todo input[type='checkbox']");
  await click(port, sessionId, "[data-status='done']");
  await waitForText(port, sessionId, "article.todo.done", "created by raw WebDriver", 60_000);
  console.log("tauri webdriver todo smoke passed");
} finally {
  if (sessionId) {
    await request(port, "DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  await stopDriver(driver);
  rmSync(appData, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}

async function stopDriver(driver) {
  if (!driver || driver.exitCode !== null || driver.signalCode !== null) return;
  const exited = new Promise((resolve) => driver.once("exit", resolve));
  try {
    if (process.platform !== "win32" && driver.pid) {
      process.kill(-driver.pid, "SIGTERM");
    } else {
      driver.kill("SIGTERM");
    }
  } catch {
    return;
  }
  const stopped = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
  if (stopped) return;
  try {
    if (process.platform !== "win32" && driver.pid) {
      process.kill(-driver.pid, "SIGKILL");
    } else {
      driver.kill("SIGKILL");
    }
  } catch {
    // Process already exited.
  }
}

async function setValue(port, sessionId, selector, value) {
  const id = await element(port, sessionId, selector);
  await request(port, "POST", `/session/${sessionId}/element/${id}/clear`, {});
  await request(port, "POST", `/session/${sessionId}/element/${id}/value`, {
    text: value,
    value: [...value],
  });
}

async function click(port, sessionId, selector) {
  const id = await element(port, sessionId, selector);
  await request(port, "POST", `/session/${sessionId}/element/${id}/click`, {});
}

async function element(port, sessionId, selector) {
  const response = await request(port, "POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector,
  });
  const value = response.value ?? response;
  const id = value[webdriverElement] ?? value.ELEMENT;
  if (!id) {
    throw new Error(`element ${selector} response missing element id: ${JSON.stringify(response)}`);
  }
  return id;
}

async function waitForText(port, sessionId, selector, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await execute(
      port,
      sessionId,
      `return document.querySelector(${JSON.stringify(selector)})?.textContent ?? "";`,
    );
    if (String(text).includes(expected)) return;
    await sleep(500);
  }
  const body = await execute(port, sessionId, "return document.body?.innerText ?? '';");
  throw new Error(`timed out waiting for ${selector} to contain ${expected}; body was: ${body}`);
}

async function execute(port, sessionId, script) {
  const response = await request(port, "POST", `/session/${sessionId}/execute/sync`, {
    script,
    args: [],
  });
  return response.value;
}

async function request(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} failed ${response.status}: ${text}`);
  }
  if (json.value?.error) {
    throw new Error(`${method} ${path} failed: ${JSON.stringify(json.value)}`);
  }
  return json;
}

async function waitForDriver(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await request(port, "GET", "/status");
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("timed out waiting for tauri-driver");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        server.close(() => resolve(address.port));
      } else {
        server.close(() => reject(new Error("could not allocate a local port")));
      }
    });
    server.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
