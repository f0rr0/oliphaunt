import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installNativeDirectProcSignalSentinel,
  verifyNativeDirectProcSignalSurvival,
  withNativeDirectExtensionSignalIsolation,
} from "./fixtures/js-exact-candidate-procsignal.mjs";

const RELEASE_ROOT = path.dirname(fileURLToPath(import.meta.url));

function result(value) {
  return {
    getText(row, column) {
      expect(row).toBe(0);
      expect(column).toBe("proc_signal_status");
      return value;
    },
  };
}

function signalHost() {
  let handler;
  let now = 0;
  return {
    add(next) {
      expect(handler).toBeUndefined();
      handler = next;
    },
    remove(expected) {
      expect(expected).toBeDefined();
      handler = undefined;
    },
    send() {
      handler?.();
    },
    now: () => now,
    async sleep(milliseconds) {
      now += milliseconds;
    },
    emit() {
      handler?.();
    },
    replace(next) {
      handler = next;
    },
    active: () => handler !== undefined,
  };
}

test("preserves the host listener and contains self-targeted ProcSignal delivery", async () => {
  const queries = [];
  const checkpoints = [];
  const database = {
    async query(sql) {
      queries.push(sql);
      return queries.length === 1 ? result("sent") : result("survived");
    },
  };
  const detail = { root: "source" };
  const host = signalHost();
  const checkpoint = async (event, value) => {
    checkpoints.push({ event, detail: value });
  };
  const sentinel = await installNativeDirectProcSignalSentinel(
    "node",
    checkpoint,
    detail,
    host,
  );

  await verifyNativeDirectProcSignalSurvival(
    database,
    sentinel,
    checkpoint,
    detail,
  );
  await sentinel.dispose();

  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain("pg_log_backend_memory_contexts(pg_backend_pid())");
  expect(queries[1]).toContain("'survived'");
  expect(checkpoints).toEqual([
    { event: "host-sigusr1-sentinel-installed", detail },
    { event: "host-sigusr1-probe-before", detail },
    { event: "host-sigusr1-probe-after", detail },
    { event: "proc-signal-self-dispatch-before", detail },
    { event: "proc-signal-self-dispatch-after", detail },
    { event: "proc-signal-host-isolation-verified", detail },
    { event: "proc-signal-survival-verified", detail },
    { event: "host-sigusr1-sentinel-removed", detail },
  ]);
});

test("does not claim survival when dispatch fails or the follow-up query is unusable", async () => {
  for (const values of [["not-sent"], ["sent", "not-survived"]]) {
    const checkpoints = [];
    let queryIndex = 0;
    const database = {
      async query() {
        return result(values[queryIndex++]);
      },
    };

    await expect(verifyNativeDirectProcSignalSurvival(
      database,
      undefined,
      async (event) => checkpoints.push(event),
    )).rejects.toThrow();
    expect(checkpoints.at(-1)).not.toBe("proc-signal-survival-verified");
  }
});

test("rejects an overwritten host handler and a ProcSignal that escapes to it", async () => {
  const checkpoint = async () => {};

  const overwrittenHost = signalHost();
  const overwritten = await installNativeDirectProcSignalSentinel(
    "node",
    checkpoint,
    {},
    overwrittenHost,
  );
  overwrittenHost.replace(() => {});
  await expect(verifyNativeDirectProcSignalSurvival(
    { query: async () => result("sent") },
    overwritten,
    checkpoint,
  )).rejects.toThrow(/listener must remain installed/u);
  await overwritten.dispose();

  const leakingHost = signalHost();
  const leaking = await installNativeDirectProcSignalSentinel(
    "node",
    checkpoint,
    {},
    leakingHost,
  );
  let queryIndex = 0;
  await expect(verifyNativeDirectProcSignalSurvival(
    {
      async query() {
        queryIndex += 1;
        if (queryIndex === 1) leakingHost.emit();
        return result(queryIndex === 1 ? "sent" : "survived");
      },
    },
    leaking,
    checkpoint,
  )).rejects.toThrow(/must not escape/u);
  await leaking.dispose();
});

test("brackets every extension activation with named host-signal evidence", async () => {
  const checkpoints = [];
  const detail = { sqlName: "bloom" };
  const host = signalHost();
  const sentinel = await installNativeDirectProcSignalSentinel(
    "node",
    async () => {},
    {},
    host,
  );
  let activations = 0;

  const value = await withNativeDirectExtensionSignalIsolation(
    sentinel,
    async (event, evidence) => checkpoints.push({ event, evidence }),
    detail,
    async () => {
      activations += 1;
      return "activated";
    },
  );

  expect(value).toBe("activated");
  expect(activations).toBe(1);
  expect(checkpoints).toEqual([
    {
      event: "host-sigusr1-extension-probe-before",
      evidence: { sqlName: "bloom", boundary: "before" },
    },
    {
      event: "host-sigusr1-extension-probe-after",
      evidence: { sqlName: "bloom", boundary: "before" },
    },
    {
      event: "host-sigusr1-extension-probe-before",
      evidence: { sqlName: "bloom", boundary: "after" },
    },
    {
      event: "host-sigusr1-extension-probe-after",
      evidence: { sqlName: "bloom", boundary: "after" },
    },
    {
      event: "host-sigusr1-extension-isolation-verified",
      evidence: detail,
    },
  ]);
  await sentinel.dispose();
});

test("rejects an extension that overwrites the host handler or leaks SIGUSR1", async () => {
  const checkpoint = async () => {};

  const overwrittenHost = signalHost();
  const overwritten = await installNativeDirectProcSignalSentinel(
    "node",
    checkpoint,
    {},
    overwrittenHost,
  );
  await expect(withNativeDirectExtensionSignalIsolation(
    overwritten,
    checkpoint,
    { sqlName: "bloom" },
    async () => overwrittenHost.replace(() => {}),
  )).rejects.toThrow(/must remain installed after activating extension bloom/u);
  await overwritten.dispose();

  const leakingHost = signalHost();
  const leaking = await installNativeDirectProcSignalSentinel(
    "node",
    checkpoint,
    {},
    leakingHost,
  );
  await expect(withNativeDirectExtensionSignalIsolation(
    leaking,
    checkpoint,
    { sqlName: "bloom" },
    async () => leakingHost.emit(),
  )).rejects.toThrow(/extension bloom must not leak PostgreSQL SIGUSR1/u);
  await leaking.dispose();
});

test("unsupported hosts activate extensions without signal waits or evidence", async () => {
  let checkpoints = 0;
  let activations = 0;
  await withNativeDirectExtensionSignalIsolation(
    undefined,
    async () => {
      checkpoints += 1;
    },
    { sqlName: "bloom" },
    async () => {
      activations += 1;
    },
  );
  expect(checkpoints).toBe(0);
  expect(activations).toBe(1);
});

test("removes the host listener when installation evidence cannot be recorded", async () => {
  const host = signalHost();
  await expect(installNativeDirectProcSignalSentinel(
    "node",
    async () => {
      throw new Error("checkpoint unavailable");
    },
    {},
    host,
  )).rejects.toThrow("checkpoint unavailable");
  expect(host.active()).toBeFalse();
});

test("stages the ProcSignal helper beside the copied exact-candidate runtime", () => {
  const runtimeSource = readFileSync(
    path.join(RELEASE_ROOT, "fixtures/js-exact-candidate-runtime.mjs"),
    "utf8",
  );
  const consumerSource = readFileSync(
    path.join(RELEASE_ROOT, "js-exact-candidate-consumer.mjs"),
    "utf8",
  );

  expect(runtimeSource).toContain(
    'from "./js-exact-candidate-procsignal.mjs";',
  );
  const installs = Array.from(
    runtimeSource.matchAll(/installNativeDirectProcSignalSentinel\(/gu),
    (match) => match.index,
  );
  const opens = Array.from(
    runtimeSource.matchAll(/await Oliphaunt\.open\(/gu),
    (match) => match.index,
  );
  expect(installs).toHaveLength(2);
  expect(opens).toHaveLength(2);
  expect(installs[0]).toBeLessThan(opens[0]);
  expect(installs[1]).toBeLessThan(opens[1]);
  expect(consumerSource).toContain(
    '"tools/release/fixtures/js-exact-candidate-procsignal.mjs"',
  );
  expect(consumerSource).toContain(
    'path.join(consumerRoot, "js-exact-candidate-procsignal.mjs")',
  );
});
