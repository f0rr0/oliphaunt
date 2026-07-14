#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_TRUSTED_PUBLISHER,
  NPM_TRUST_BATCH_SIZE,
  buildTrustedPublisherPlan,
  classifyCratesIoTrustConfigs,
  classifyNpmTrustConfigs,
  createCratesIoTrustClient,
  createNpmTrustClient,
  reconcileTrustedPublishers,
  selectTrustedPublisherIdentities,
} from "./trusted-publisher-config.mjs";

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
  assert.equal(classifyNpmTrustConfigs([{ ...exactNpm(), file: "release-execute.yml" }]).state, "conflict");
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

test("npm client checks the management CLI and sends exact non-staged flags", () => {
  const calls = [];
  const client = createNpmTrustClient({
    runImpl(args) {
      calls.push(args);
      if (args[0] === "--version") return "11.15.0\n";
      if (args[1] === "list") return `${JSON.stringify(exactNpm())}\n`;
      return `${JSON.stringify(exactNpm())}\n`;
    },
  });
  assert.equal(client.checkRuntime(), "11.15.0");
  assert.deepEqual(client.list("@oliphaunt/example"), [exactNpm()]);
  client.create("@oliphaunt/example");
  assert.deepEqual(calls[2].slice(0, 4), ["trust", "github", "@oliphaunt/example", "--file"]);
  assert.ok(calls[2].includes("release.yml"));
  assert.ok(calls[2].includes("release-publish"));
  assert.ok(calls[2].includes("--allow-publish"));
  assert.ok(!calls[2].includes("--allow-stage-publish"));
  assert.throws(() => createNpmTrustClient({ runImpl: () => "11.14.9\n" }).checkRuntime(), /too old/u);
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
  const client = {
    async list(name) { return structuredClone(state.get(name)); },
    async create(name) {
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
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(report.mode, "apply");
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(report.created, ["npm:@oliphaunt/two"]);
  assert.deepEqual(creates, ["@oliphaunt/two"]);
  assert.equal(sleeps.length, 5);

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
