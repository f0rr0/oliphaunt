#!/usr/bin/env bun

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  EXPECTED_TRUSTED_PUBLISHER,
  NPM_TRUST_BATCH_SIZE,
  buildTrustedPublisherPlan,
  classifyCratesIoTrustConfigs,
  classifyNpmTrustConfigs,
  createCratesIoTrustClient,
  createNpmTrustClient,
  npmTrustGithubArgs,
  npmTrustListArgs,
  reconcileTrustedPublishers,
  reconcileTrustedPublishersToFile,
  reserveJsonFile,
  runNpmTrustCommand,
  selectTrustedPublisherIdentities,
  writeJsonFile,
} from "./trusted-publisher-config.mjs";

const NPM_LIST_HELP = "Options: --json --registry";
const NPM_GITHUB_HELP =
  "Options: --file --repository --environment --allow-publish --json --registry --yes";
const MODULE_URL = new URL("trusted-publisher-config.mjs", import.meta.url).href;

function carrier(ecosystem, name, product = "one") {
  return {
    id: `${ecosystem}:${name}`,
    ecosystem,
    name,
    product,
    version: "1.2.3",
  };
}

function lock(carriers) {
  return {
    lockDigest: "a".repeat(64),
    catalogDigest: "b".repeat(64),
    source: { commit: "c".repeat(40), tree: "d".repeat(40) },
    products: [
      { id: "one", version: "1.2.3" },
      { id: "two", version: "2.0.0" },
    ],
    carriers,
  };
}

function exactNpm() {
  return {
    id: "publisher-id",
    type: "github",
    repository: EXPECTED_TRUSTED_PUBLISHER.repository,
    file: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
    permissions: [...EXPECTED_TRUSTED_PUBLISHER.npmPermissions],
  };
}

function exactCrates(name) {
  return {
    id: 1,
    crate: name,
    repository_owner: EXPECTED_TRUSTED_PUBLISHER.repositoryOwner,
    repository_name: EXPECTED_TRUSTED_PUBLISHER.repositoryName,
    workflow_filename: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
  };
}

test("derives exact npm/Cargo identities and bounded npm batches from the lock", () => {
  const npm = Array.from({ length: NPM_TRUST_BATCH_SIZE + 1 }, (_, index) =>
    carrier("npm", `@oliphaunt/package-${String(index).padStart(2, "0")}`));
  const plan = buildTrustedPublisherPlan(lock([
    carrier("jsr", "@oliphaunt/ts"),
    carrier("cargo", "oliphaunt-one"),
    ...npm,
  ]));
  assert.deepEqual(plan.counts, { cargo: 1, npm: NPM_TRUST_BATCH_SIZE + 1, total: NPM_TRUST_BATCH_SIZE + 2 });
  assert.equal(plan.npmBatches.length, 2);
  assert.deepEqual(plan.npmBatches.map(({ count }) => count), [NPM_TRUST_BATCH_SIZE, 1]);
  assert.equal(plan.expected.workflowFilename, "release.yml");
  assert.equal(plan.expected.environment, "release-publish");

  assert.throws(() => selectTrustedPublisherIdentities(plan, "npm"), /requires --batch/u);
  assert.equal(selectTrustedPublisherIdentities(plan, "npm", 2).identities.length, 1);
  assert.equal(selectTrustedPublisherIdentities(plan, "cargo").identities.length, 1);
  assert.throws(() => selectTrustedPublisherIdentities(plan, "cargo", 1), /used only for npm/u);
});

test("rejects unknown or duplicate product selection", () => {
  const value = lock([carrier("cargo", "oliphaunt-one")]);
  assert.throws(() => buildTrustedPublisherPlan(value, { products: ["missing"] }), /absent from the exact lock/u);
  assert.throws(() => buildTrustedPublisherPlan(value, { products: ["one", "one"] }), /unique string list/u);
});

test("classifies only the exact npm publish permission and caller identity as trusted", () => {
  assert.deepEqual(classifyNpmTrustConfigs([]), { state: "missing" });
  assert.deepEqual(classifyNpmTrustConfigs([exactNpm()]), { state: "exact" });
  assert.equal(classifyNpmTrustConfigs([{ ...exactNpm(), file: "wrong.yml" }]).state, "conflict");
  assert.equal(classifyNpmTrustConfigs([{
    ...exactNpm(),
    permissions: ["createPackage", "createStagedPackage"],
  }]).state, "conflict");
  assert.equal(classifyNpmTrustConfigs([exactNpm(), exactNpm()]).state, "conflict");
});

test("classifies crates.io configuration strictly and treats extras as conflicts", () => {
  assert.deepEqual(classifyCratesIoTrustConfigs([], "oliphaunt-one"), { state: "missing" });
  assert.deepEqual(classifyCratesIoTrustConfigs([exactCrates("oliphaunt-one")], "oliphaunt-one"), { state: "exact" });
  assert.equal(classifyCratesIoTrustConfigs([{
    ...exactCrates("oliphaunt-one"),
    environment: null,
  }], "oliphaunt-one").state, "conflict");
  assert.equal(classifyCratesIoTrustConfigs([
    exactCrates("oliphaunt-one"),
    { ...exactCrates("oliphaunt-one"), id: 2, repository_name: "other" },
  ], "oliphaunt-one").state, "conflict");
});

test("npm client checks the management CLI and sends exact non-staged flags", async () => {
  const calls = [];
  const client = createNpmTrustClient({
    runImpl(args, _context, options) {
      calls.push({ args, options });
      if (args[0] === "--version") return "11.15.0\n";
      if (args[2] === "--help" && args[1] === "list") return NPM_LIST_HELP;
      if (args[2] === "--help" && args[1] === "github") return NPM_GITHUB_HELP;
      if (args[1] === "list") return `${JSON.stringify(exactNpm())}\n`;
      return `${JSON.stringify(exactNpm())}\n`;
    },
  });
  assert.equal(client.checkRuntime(), "11.15.0");
  client.authorizeAudit("@oliphaunt/example");
  assert.deepEqual(await client.list("@oliphaunt/example"), [exactNpm()]);
  client.create("@oliphaunt/example");
  assert.deepEqual(calls[3].args, npmTrustListArgs("@oliphaunt/example"));
  assert.deepEqual(calls[3].options, { interactiveAudit: true });
  assert.deepEqual(calls[4].args, npmTrustListArgs("@oliphaunt/example"));
  assert.deepEqual(calls[5].args, npmTrustGithubArgs("@oliphaunt/example"));
  assert.ok(calls[5].args.includes("release.yml"));
  assert.ok(calls[5].args.includes("release-publish"));
  assert.ok(calls[5].args.includes("--allow-publish"));
  assert.ok(!calls[5].args.includes("--allow-stage-publish"));
  assert.ok(calls.every(({ args }) => args.every((arg) => !arg.startsWith("--fetch-"))));
  assert.throws(() => npmTrustListArgs("--fetch-retries"), /canonical bounded @oliphaunt identity/u);
  assert.throws(() => npmTrustGithubArgs("@other/example"), /canonical bounded @oliphaunt identity/u);
  assert.throws(
    () => createNpmTrustClient({
      runImpl: (args) => args[0] === "--version" ? "11.14.9\n" : "",
    }).checkRuntime(),
    /too old/u,
  );
});

test("npm captured list retries once through a read-only TTY warm-up only for OTP", async () => {
  const events = [];
  let capturedAttempts = 0;
  const client = createNpmTrustClient({
    runImpl(args, _context, options) {
      if (options?.interactiveAudit === true) {
        events.push("warm-up");
        return "";
      }
      events.push("captured");
      capturedAttempts += 1;
      if (capturedAttempts === 1) {
        throw Object.assign(new Error("npm error code EOTP"), {
          npmAuthenticationRequired: true,
        });
      }
      return `${JSON.stringify(exactNpm())}\n`;
    },
    sleepImpl: async (milliseconds) => events.push(`sleep:${milliseconds}`),
  });
  assert.deepEqual(await client.list("@oliphaunt/example"), [exactNpm()]);
  assert.deepEqual(events, [
    "captured",
    "sleep:2000",
    "warm-up",
    "sleep:2000",
    "captured",
  ]);

  let boundedCalls = 0;
  const expired = createNpmTrustClient({
    runImpl(_args, _context, options) {
      boundedCalls += 1;
      if (options?.interactiveAudit === true) return "";
      throw Object.assign(new Error("npm error code EOTP"), {
        npmAuthenticationRequired: true,
      });
    },
    sleepImpl: async () => {},
  });
  await assert.rejects(
    () => expired.list("@oliphaunt/example"),
    /still requires OTP after the bounded read-only warm-up/u,
  );
  assert.equal(boundedCalls, 3);

  let ordinaryCalls = 0;
  const ordinaryFailure = createNpmTrustClient({
    runImpl() {
      ordinaryCalls += 1;
      throw new Error("network unavailable");
    },
  });
  await assert.rejects(() => ordinaryFailure.list("@oliphaunt/example"), /network unavailable/u);
  assert.equal(ordinaryCalls, 1, "non-authentication failures must not be retried");
});

test("npm command policy captures bounded evidence and reserves inherited TTYs for warm-up and mutation", () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      error: undefined,
      status: 0,
      stderr: options.stdio === "inherit" ? null : "",
      stdout: options.stdio === "inherit" ? null : "read output\n",
    };
  };

  assert.equal(
    runNpmTrustCommand(["--version"], "npm --version", { spawnImpl }),
    "read output\n",
  );
  assert.equal(
    runNpmTrustCommand(
      npmTrustListArgs("@oliphaunt/example"),
      "npm trust list @oliphaunt/example",
      { spawnImpl },
    ),
    "read output\n",
  );
  assert.equal(
    runNpmTrustCommand(
      npmTrustListArgs("@oliphaunt/example"),
      "npm trust list authentication warm-up for @oliphaunt/example",
      {
        spawnImpl,
        interactiveAudit: true,
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
    ),
    "",
  );
  assert.equal(
    runNpmTrustCommand(
      npmTrustGithubArgs("@oliphaunt/example"),
      "npm trust github @oliphaunt/example",
      { spawnImpl, stdinIsTTY: true, stdoutIsTTY: true },
    ),
    "",
  );

  for (const call of calls.slice(0, 2)) {
    assert.equal(call.command, "npm");
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(call.options.timeout, 30_000);
    assert.equal(call.options.maxBuffer, 256 * 1024);
    assert.equal(call.options.encoding, "utf8");
  }
  assert.equal(calls[0].options.env.NPM_CONFIG_FETCH_RETRIES, "0");
  assert.equal(calls[1].options.env.NPM_CONFIG_FETCH_RETRIES, "3");
  assert.equal(calls[1].options.env.NPM_CONFIG_FETCH_RETRY_MINTIMEOUT, "1000");
  assert.equal(calls[1].options.env.NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT, "5000");
  assert.equal(calls[1].options.env.NPM_CONFIG_FETCH_TIMEOUT, "20000");
  for (const interactive of calls.slice(2)) {
    assert.equal(interactive.options.stdio, "inherit");
    assert.equal(interactive.options.timeout, 5 * 60_000);
    assert.equal("encoding" in interactive.options, false);
    assert.equal("maxBuffer" in interactive.options, false);
  }
  assert.equal(calls[2].options.env.NPM_CONFIG_FETCH_RETRIES, "3");
  assert.equal(calls[3].options.env.NPM_CONFIG_FETCH_RETRIES, "0");
  assert.ok(calls.every(({ args }) => args.every((arg) => !arg.startsWith("--fetch-"))));
  assert.throws(
    () => runNpmTrustCommand(
      [...npmTrustListArgs("@oliphaunt/example"), "--fetch-retries", "3"],
      "npm trust list @oliphaunt/example",
      { spawnImpl },
    ),
    /refusing unsupported npm trust list arguments/u,
  );
  assert.throws(
    () => runNpmTrustCommand(["publish", "package.tgz"], "npm publish", { spawnImpl }),
    /refusing unsupported npm management command/u,
  );
  assert.throws(
    () => runNpmTrustCommand(
      npmTrustGithubArgs("@oliphaunt/example"),
      "npm trust github @oliphaunt/example",
      { spawnImpl, stdinIsTTY: false, stdoutIsTTY: true },
    ),
    /requires an interactive terminal/u,
  );
  assert.equal(calls.length, 4, "unsupported and non-TTY npm commands must fail before spawn");

  assert.throws(
    () => runNpmTrustCommand(
      npmTrustListArgs("@oliphaunt/example"),
      "npm trust list @oliphaunt/example",
      {
        spawnImpl: () => ({
          status: 1,
          stdout: "",
          stderr: "npm error code EOTP\nnpm error This operation requires a one-time password",
        }),
      },
    ),
    (cause) => cause.npmAuthenticationRequired === true,
  );
});

test("awaited JSON output remains complete through a pipe beyond Bun's 64 KiB console boundary", async () => {
  const script = [
    `const { writeJson } = await import(${JSON.stringify(MODULE_URL)});`,
    'await writeJson({ payload: "x".repeat(90_000), tail: "complete" });',
  ].join("\n");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({
      signal,
      status,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout),
    }));
  });
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 80 * 1024);
  assert.equal(result.stdout.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), {
    payload: "x".repeat(90_000),
    tail: "complete",
  });
});

test("file reports are atomically created as mode 0600, complete, and never overwritten", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oliphaunt-trust-report-"));
  try {
    const output = path.join(directory, "npm-audit.json");
    const report = {
      payload: "x".repeat(90_000),
      tail: "complete",
    };
    assert.equal(await writeJsonFile(report, output), output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const bytes = await readFile(output, "utf8");
    assert.ok(Buffer.byteLength(bytes) > 80 * 1024);
    assert.equal(bytes.at(-1), "\n");
    assert.deepEqual(JSON.parse(bytes), report);
    await assert.rejects(
      () => writeJsonFile({ replaced: true }, output),
      /refusing to overwrite existing --output file/u,
    );
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), report);
    assert.deepEqual(await readdir(directory), ["npm-audit.json"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("reservation never exposes the final path before a complete commit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oliphaunt-trust-atomic-"));
  try {
    const output = path.join(directory, "pending.json");
    const reserved = await reserveJsonFile(output);
    await assert.rejects(() => stat(output), (cause) => cause.code === "ENOENT");
    const during = await readdir(directory);
    assert.ok(during.some((entry) => entry.endsWith(".oliphaunt-reservation")));
    assert.ok(during.some((entry) => entry.includes(".tmp-")));
    assert.ok(!during.includes("pending.json"));
    assert.ok(!during.some((entry) => entry.includes(".probe-")));
    await reserved.abort();
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("report reservation fails before every registry or initialization call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oliphaunt-trust-reservation-"));
  try {
    const existing = path.join(directory, "existing.json");
    await writeJsonFile({ existing: true }, existing);
    const plan = buildTrustedPublisherPlan(lock([
      carrier("npm", "@oliphaunt/example"),
    ]));
    let calls = 0;
    const options = {
      plan,
      ecosystem: "npm",
      batch: 1,
      apply: true,
      client: {
        authorizeAudit() { calls += 1; },
        async list() {
          calls += 1;
          return [];
        },
        async create() { calls += 1; },
      },
      initialize: async () => { calls += 1; },
      sleepImpl: async () => {},
    };
    await assert.rejects(
      () => reconcileTrustedPublishersToFile({
        ...options,
        outputFile: existing,
      }),
      /refusing to overwrite existing --output file/u,
    );
    await assert.rejects(
      () => reconcileTrustedPublishersToFile({
        ...options,
        outputFile: path.join(directory, "missing-parent", "report.json"),
      }),
      /could not reserve --output file/u,
    );
    assert.equal(calls, 0, "output reservation must precede client initialization and registry calls");
    assert.deepEqual(await readdir(directory), ["existing.json"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("crates.io client uses scoped bearer auth, exact payload, and no delete path", async () => {
  const calls = [];
  const client = createCratesIoTrustClient({
    token: "configuration-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === "GET") {
        return new Response(JSON.stringify({ github_configs: [exactCrates("oliphaunt-one")], meta: { total: 1, next_page: null } }));
      }
      return new Response(JSON.stringify({ github_config: exactCrates("oliphaunt-one") }));
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(await client.list("oliphaunt-one"), [exactCrates("oliphaunt-one")]);
  await client.create("oliphaunt-one");
  const getUrl = new URL(calls[0].url);
  assert.equal(getUrl.origin + getUrl.pathname, "https://crates.io/api/v1/trusted_publishing/github_configs");
  assert.equal(getUrl.searchParams.get("crate"), "oliphaunt-one");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer configuration-secret");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    github_config: {
      crate: "oliphaunt-one",
      repository_owner: "f0rr0",
      repository_name: "oliphaunt",
      workflow_filename: "release.yml",
      environment: "release-publish",
    },
  });
  assert.ok(calls.every(({ init }) => init.method !== "DELETE"));
});

test("crates.io read audit retries bounded retryable responses but create is not replayed", async () => {
  let reads = 0;
  const sleeps = [];
  const client = createCratesIoTrustClient({
    token: "configuration-secret",
    fetchImpl: async (_url, init) => {
      if (init.method === "POST") return new Response("unavailable", { status: 503 });
      reads += 1;
      if (reads === 1) return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
      return new Response(JSON.stringify({ github_configs: [], meta: { total: 0, next_page: null } }));
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(await client.list("oliphaunt-one"), []);
  assert.equal(reads, 2);
  assert.deepEqual(sleeps, [0]);
  await assert.rejects(() => client.create("oliphaunt-one"), /HTTP 503/u);
});

test("apply is pre-audited, idempotent, and verified after each missing configuration", async () => {
  const plan = buildTrustedPublisherPlan(lock([
    carrier("npm", "@oliphaunt/one"),
    carrier("npm", "@oliphaunt/two"),
  ]));
  const state = new Map([
    ["@oliphaunt/one", [exactNpm()]],
    ["@oliphaunt/two", []],
  ]);
  const creates = [];
  const sleeps = [];
  const events = [];
  const client = {
    async authorizeAudit(name) { events.push(`authorize:${name}`); },
    async list(name) {
      events.push(`list:${name}`);
      return structuredClone(state.get(name));
    },
    async create(name) {
      events.push(`create:${name}`);
      creates.push(name);
      state.set(name, [exactNpm()]);
    },
  };
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem: "npm",
    batch: 1,
    apply: true,
    client,
    sleepImpl: async (milliseconds) => {
      sleeps.push(milliseconds);
      events.push(`sleep:${milliseconds}`);
    },
  });
  assert.equal(report.mode, "apply");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.created, ["npm:@oliphaunt/two"]);
  assert.deepEqual(creates, ["@oliphaunt/two"]);
  assert.equal(sleeps.length, 8);
  assert.deepEqual(events.slice(0, 7), [
    "authorize:@oliphaunt/one",
    "sleep:2000",
    "list:@oliphaunt/one",
    "sleep:2000",
    "list:@oliphaunt/two",
    "sleep:2000",
    "create:@oliphaunt/two",
  ]);
  assert.equal(events.filter((event) => event.startsWith("authorize:")).length, 2);
  assert.ok(
    events.lastIndexOf("authorize:@oliphaunt/one") > events.indexOf("create:@oliphaunt/two"),
    "the final audit pass must refresh the read-only authentication window",
  );

  const second = await reconcileTrustedPublishers({
    plan,
    ecosystem: "npm",
    batch: 1,
    apply: true,
    client,
    sleepImpl: async () => {},
  });
  assert.deepEqual(second.created, []);
  assert.deepEqual(creates, ["@oliphaunt/two"]);
});

test("an applied trusted-publisher mutation with a lost response reconciles without replay", async () => {
  const plan = buildTrustedPublisherPlan(lock([carrier("cargo", "oliphaunt-one")]));
  let present = false;
  let creates = 0;
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem: "cargo",
    apply: true,
    client: {
      async list() { return present ? [exactCrates("oliphaunt-one")] : []; },
      async create() {
        creates += 1;
        present = true;
        throw new Error("response timed out after the registry applied the configuration");
      },
    },
    sleepImpl: async () => {},
  });
  assert.equal(creates, 1);
  assert.deepEqual(report.created, ["cargo:oliphaunt-one"]);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.conflicts, []);
});

test("any conflicting configuration blocks every mutation in the selected batch", async () => {
  const plan = buildTrustedPublisherPlan(lock([
    carrier("cargo", "oliphaunt-one"),
    carrier("cargo", "oliphaunt-two"),
  ]));
  let creates = 0;
  const client = {
    async list(name) {
      return name === "oliphaunt-one"
        ? []
        : [{ ...exactCrates(name), workflow_filename: "wrong.yml" }];
    },
    async create() { creates += 1; },
  };
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem: "cargo",
    apply: true,
    client,
    sleepImpl: async () => {},
  });
  assert.equal(report.mode, "apply-blocked");
  assert.equal(report.conflicts.length, 1);
  assert.equal(creates, 0);
});
