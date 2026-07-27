import assert from "node:assert/strict";

const PROC_SIGNAL_STATUS_COLUMN = "proc_signal_status";
const HOST_SIGNAL_PROBE_TIMEOUT_MS = 2_000;
const HOST_SIGNAL_POLL_MS = 10;
const HOST_SIGNAL_QUIET_MS = 250;
const HOST_SIGNAL_EXTENSION_QUIET_MS = 25;

function nodeSigusr1Host(runtime) {
  if (runtime !== "node" || globalThis.process?.platform === "win32") return undefined;
  return {
    add(handler) {
      globalThis.process.on("SIGUSR1", handler);
    },
    remove(handler) {
      globalThis.process.off("SIGUSR1", handler);
    },
    send() {
      globalThis.process.kill(globalThis.process.pid, "SIGUSR1");
    },
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

async function waitForCount(
  sentinel,
  expected,
  message = "the Node host SIGUSR1 listener must remain installed after nativeDirect opens",
) {
  const deadline = sentinel.host.now() + HOST_SIGNAL_PROBE_TIMEOUT_MS;
  while (sentinel.count() < expected && sentinel.host.now() < deadline) {
    await sentinel.host.sleep(HOST_SIGNAL_POLL_MS);
  }
  assert.equal(sentinel.count(), expected, message);
}

async function probeHostSignal(sentinel, checkpoint, detail, boundary, baseline) {
  const evidence = { ...detail, boundary };
  const beforeProbe = baseline ?? sentinel.count();
  await checkpoint("host-sigusr1-extension-probe-before", evidence);
  assert.equal(
    sentinel.count(),
    beforeProbe,
    `extension ${detail.sqlName} must not leak PostgreSQL SIGUSR1 into the Node host`,
  );
  sentinel.host.send();
  await waitForCount(
    sentinel,
    beforeProbe + 1,
    `the Node host SIGUSR1 listener must remain installed ${boundary} activating extension ${detail.sqlName}`,
  );
  await checkpoint("host-sigusr1-extension-probe-after", evidence);
}

export async function installNativeDirectProcSignalSentinel(
  runtime,
  checkpoint,
  detail = {},
  host = nodeSigusr1Host(runtime),
) {
  if (host === undefined) {
    await checkpoint("host-sigusr1-sentinel-skipped", {
      ...detail,
      reason: runtime === "node" ? "windows-has-no-sigusr1" : "node-only-host-proof",
    });
    return undefined;
  }

  let observed = 0;
  let disposed = false;
  const handler = () => {
    observed += 1;
  };
  host.add(handler);
  try {
    await checkpoint("host-sigusr1-sentinel-installed", detail);
  } catch (error) {
    host.remove(handler);
    throw error;
  }
  return {
    host,
    count: () => observed,
    async dispose() {
      if (disposed) return;
      disposed = true;
      host.remove(handler);
      await checkpoint("host-sigusr1-sentinel-removed", detail);
    },
  };
}

export async function verifyNativeDirectProcSignalSurvival(
  database,
  sentinel,
  checkpoint,
  detail = {},
) {
  let hostSignalBaseline;
  if (sentinel !== undefined) {
    const beforeProbe = sentinel.count();
    await checkpoint("host-sigusr1-probe-before", detail);
    sentinel.host.send();
    await waitForCount(sentinel, beforeProbe + 1);
    hostSignalBaseline = sentinel.count();
    await checkpoint("host-sigusr1-probe-after", detail);
  }

  await checkpoint("proc-signal-self-dispatch-before", detail);
  const dispatch = await database.query(`
    SELECT CASE
      WHEN pg_log_backend_memory_contexts(pg_backend_pid()) THEN 'sent'
      ELSE 'not-sent'
    END AS ${PROC_SIGNAL_STATUS_COLUMN}
  `);
  assert.equal(
    dispatch.getText(0, PROC_SIGNAL_STATUS_COLUMN),
    "sent",
    "the embedded backend must dispatch its self-targeted ProcSignal",
  );
  await checkpoint("proc-signal-self-dispatch-after", detail);

  if (sentinel !== undefined) {
    await sentinel.host.sleep(HOST_SIGNAL_QUIET_MS);
    assert.equal(
      sentinel.count(),
      hostSignalBaseline,
      "PostgreSQL self-targeted ProcSignal delivery must not escape to the Node host SIGUSR1 listener",
    );
    await checkpoint("proc-signal-host-isolation-verified", detail);
  }

  const followUp = await database.query(
    `SELECT 'survived' AS ${PROC_SIGNAL_STATUS_COLUMN}`,
  );
  assert.equal(
    followUp.getText(0, PROC_SIGNAL_STATUS_COLUMN),
    "survived",
    "the nativeDirect host and backend must remain queryable after ProcSignal dispatch",
  );
  await checkpoint("proc-signal-survival-verified", detail);
}

export async function withNativeDirectExtensionSignalIsolation(
  sentinel,
  checkpoint,
  detail,
  activate,
) {
  assert.equal(typeof detail?.sqlName, "string", "extension signal evidence requires sqlName");
  assert.ok(detail.sqlName.length > 0, "extension signal evidence requires a non-empty sqlName");
  assert.equal(typeof activate, "function", "extension activation callback is required");

  if (sentinel === undefined) {
    return activate();
  }

  await probeHostSignal(sentinel, checkpoint, detail, "before");
  const activationBaseline = sentinel.count();
  const value = await activate();

  await sentinel.host.sleep(HOST_SIGNAL_EXTENSION_QUIET_MS);
  assert.equal(
    sentinel.count(),
    activationBaseline,
    `extension ${detail.sqlName} must not leak PostgreSQL SIGUSR1 into the Node host`,
  );
  await probeHostSignal(sentinel, checkpoint, detail, "after", activationBaseline);
  await checkpoint("host-sigusr1-extension-isolation-verified", detail);
  return value;
}
