#!/usr/bin/env node
import { createServer } from 'node:net';

const webdriverElement = 'element-6066-11e4-a52e-4f735466cecf';

if (process.argv[2] === '--ports') {
  const servers = [createServer(), createServer()];
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          }),
      ),
    );
    console.log(
      servers
        .map((server) => {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('missing TCP address');
          return address.port;
        })
        .join(' '),
    );
  } finally {
    for (const server of servers) server.close();
  }
} else {
  await smoke();
}

async function smoke() {
  const port = Number(process.argv[2]);
  const application = process.argv[3];
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !application)
    throw new Error('usage: tauri-webdriver-smoke.mts PORT APPLICATION');
  let sessionId;
  try {
    await waitForDriver(port);
    const session = await request(port, 'POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'tauri:options': { application },
        },
      },
    });
    sessionId = session.sessionId ?? session.value?.sessionId;
    if (!sessionId) {
      throw new Error(`session response did not include sessionId: ${JSON.stringify(session)}`);
    }

    await setValue(port, sessionId, '#title', `Ship Tauri e2e ${Date.now()}`);
    await setValue(port, sessionId, '#notes', 'created by raw WebDriver');
    await setValue(port, sessionId, '#area', 'examples');
    await setValue(port, sessionId, '#context', 'public packages');
    await click(port, sessionId, "button[type='submit']");
    await waitForText(port, sessionId, 'article.todo', 'created by raw WebDriver', 60_000);
    await click(port, sessionId, "article.todo input[type='checkbox']");
    await click(port, sessionId, "[data-status='done']");
    await waitForText(port, sessionId, 'article.todo.done', 'created by raw WebDriver', 60_000);
    console.log('tauri webdriver todo smoke passed');
  } finally {
    if (sessionId) {
      await request(port, 'DELETE', `/session/${sessionId}`).catch(() => undefined);
    }
  }
}

async function setValue(port, sessionId, selector, value) {
  const id = await element(port, sessionId, selector);
  await request(port, 'POST', `/session/${sessionId}/element/${id}/clear`, {});
  await request(port, 'POST', `/session/${sessionId}/element/${id}/value`, {
    text: value,
    value: [...value],
  });
}

async function click(port, sessionId, selector) {
  const id = await element(port, sessionId, selector);
  await request(port, 'POST', `/session/${sessionId}/element/${id}/click`, {});
}

async function element(port, sessionId, selector) {
  const response = await request(port, 'POST', `/session/${sessionId}/element`, {
    using: 'css selector',
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
  const response = await request(port, 'POST', `/session/${sessionId}/execute/sync`, {
    script,
    args: [],
  });
  return response.value;
}

async function request(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json' },
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
      await request(port, 'GET', '/status');
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('timed out waiting for tauri-driver');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
