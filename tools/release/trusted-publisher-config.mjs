#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";

import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
  lockedCarriers,
} from "./publication-lock.mjs";
import { validateNpmTrustCliRuntime } from "./npm-trusted-publishing.mjs";
import { registryRetryDelaySeconds, registryStatusRetryable } from "./registry-http-retry.mjs";
import { ROOT } from "./release-graph.mjs";

export const TRUSTED_PUBLISHER_PLAN_SCHEMA = "oliphaunt-trusted-publisher-plan-v1";
export const TRUSTED_PUBLISHER_REPORT_SCHEMA = "oliphaunt-trusted-publisher-report-v1";
export const NPM_TRUST_BATCH_SIZE = 25;
export const NPM_TRUST_REQUEST_SPACING_MS = 2_000;
export const CRATES_IO_TRUST_REQUEST_SPACING_MS = 250;

export const EXPECTED_TRUSTED_PUBLISHER = Object.freeze({
  repository: "f0rr0/oliphaunt",
  repositoryOwner: "f0rr0",
  repositoryName: "oliphaunt",
  workflowFilename: "release.yml",
  environment: "release-publish",
  npmPermissions: Object.freeze(["createPackage"]),
});

const CRATES_IO_CONFIG_ENDPOINT = "https://crates.io/api/v1/trusted_publishing/github_configs";
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_READ_ATTEMPTS = 3;

function error(message) {
  return new Error(`trusted-publisher-config: ${message}`);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function selectedProducts(lock, products) {
  if (products === undefined) return undefined;
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error("products must be a non-empty unique string list");
  }
  const known = new Set(lock.products.map(({ id }) => id));
  const unknown = products.filter((product) => !known.has(product));
  if (unknown.length > 0) throw error(`products are absent from the exact lock: ${unknown.join(", ")}`);
  return new Set(products);
}

function batchRows(identities, size = NPM_TRUST_BATCH_SIZE) {
  const batches = [];
  for (let start = 0; start < identities.length; start += size) {
    const rows = identities.slice(start, start + size);
    batches.push({
      number: batches.length + 1,
      count: rows.length,
      first: rows[0].id,
      last: rows.at(-1).id,
    });
  }
  return batches;
}

export function buildTrustedPublisherPlan(lock, { products = undefined } = {}) {
  const selected = selectedProducts(lock, products);
  const identities = lockedCarriers(lock)
    .filter((carrier) => selected === undefined || selected.has(carrier.product))
    .filter((carrier) => carrier.ecosystem === "cargo" || carrier.ecosystem === "npm")
    .map(({ id, ecosystem, name, product, version }) => ({ id, ecosystem, name, product, version }))
    .sort((left, right) => compareText(left.id, right.id));
  const unique = new Set(identities.map(({ id }) => id));
  if (unique.size !== identities.length) throw error("exact lock contains duplicate npm/Cargo identities");
  const npm = identities.filter(({ ecosystem }) => ecosystem === "npm");
  const cargo = identities.filter(({ ecosystem }) => ecosystem === "cargo");
  return {
    schema: TRUSTED_PUBLISHER_PLAN_SCHEMA,
    lockDigest: lock.lockDigest,
    catalogDigest: lock.catalogDigest,
    source: lock.source,
    products: lock.products.filter(({ id }) => selected === undefined || selected.has(id)).map(({ id, version }) => ({ id, version })),
    expected: EXPECTED_TRUSTED_PUBLISHER,
    counts: { cargo: cargo.length, npm: npm.length, total: identities.length },
    npmBatchSize: NPM_TRUST_BATCH_SIZE,
    npmBatches: batchRows(npm),
    identities,
  };
}

export function selectTrustedPublisherIdentities(plan, ecosystem, batch = undefined) {
  if (ecosystem !== "cargo" && ecosystem !== "npm") {
    throw error("--ecosystem must be cargo or npm for audit/apply");
  }
  const identities = plan.identities.filter((identity) => identity.ecosystem === ecosystem);
  if (identities.length === 0) throw error(`exact lock selects no ${ecosystem} identities`);
  if (ecosystem === "cargo") {
    if (batch !== undefined) throw error("--batch is used only for npm's bounded 2FA windows");
    return { identities, batch: null, batches: 1 };
  }
  const batches = batchRows(identities);
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > batches.length) {
    throw error(`npm audit/apply requires --batch N from 1 through ${batches.length}`);
  }
  const start = (batch - 1) * NPM_TRUST_BATCH_SIZE;
  return {
    identities: identities.slice(start, start + NPM_TRUST_BATCH_SIZE),
    batch,
    batches: batches.length,
  };
}

function relevantNpmConfig(config) {
  return {
    type: config?.type ?? null,
    repository: config?.repository ?? null,
    file: config?.file ?? null,
    environment: config?.environment ?? null,
    permissions: Array.isArray(config?.permissions) ? [...config.permissions].sort(compareText) : null,
  };
}

function relevantCratesConfig(config) {
  return {
    crate: config?.crate ?? null,
    repository_owner: config?.repository_owner ?? null,
    repository_name: config?.repository_name ?? null,
    workflow_filename: config?.workflow_filename ?? null,
    environment: config?.environment ?? null,
  };
}

function exactNpmConfig(config) {
  const expected = {
    type: "github",
    repository: EXPECTED_TRUSTED_PUBLISHER.repository,
    file: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
    permissions: [...EXPECTED_TRUSTED_PUBLISHER.npmPermissions],
  };
  return stableJson(relevantNpmConfig(config)) === stableJson(expected);
}

function exactCratesConfig(config, name) {
  const expected = {
    crate: name,
    repository_owner: EXPECTED_TRUSTED_PUBLISHER.repositoryOwner,
    repository_name: EXPECTED_TRUSTED_PUBLISHER.repositoryName,
    workflow_filename: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
    environment: EXPECTED_TRUSTED_PUBLISHER.environment,
  };
  return stableJson(relevantCratesConfig(config)) === stableJson(expected);
}

export function classifyNpmTrustConfigs(configs) {
  if (!Array.isArray(configs)) throw error("npm trust list output must be a JSON object, array, or empty output");
  if (configs.length === 0) return { state: "missing" };
  if (configs.length === 1 && exactNpmConfig(configs[0])) return { state: "exact" };
  return {
    state: "conflict",
    reason: `expected exactly one publish-only GitHub configuration; observed ${JSON.stringify(configs.map(relevantNpmConfig))}`,
  };
}

export function classifyCratesIoTrustConfigs(configs, name) {
  if (!Array.isArray(configs)) throw error("crates.io github_configs must be an array");
  if (configs.length === 0) return { state: "missing" };
  if (configs.length === 1 && exactCratesConfig(configs[0], name)) return { state: "exact" };
  return {
    state: "conflict",
    reason: `expected exactly one GitHub configuration; observed ${JSON.stringify(configs.map(relevantCratesConfig))}`,
  };
}

function parseNpmJson(text, context) {
  const value = text.trim();
  if (value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw error(`${context} returned invalid JSON`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function runNpm(args, context) {
  const result = spawnSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: MAX_RESPONSE_BYTES,
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw error(`${context} failed${Number.isInteger(result.status) ? ` with exit ${result.status}` : ""}; no mutation is retried automatically`);
  }
  return result.stdout ?? "";
}

export function createNpmTrustClient({ runImpl = runNpm } = {}) {
  return {
    checkRuntime() {
      const version = runImpl(["--version"], "npm --version").trim();
      validateNpmTrustCliRuntime(version);
      return version;
    },
    list(name) {
      const output = runImpl([
        "trust", "list", name,
        "--json",
        "--registry", "https://registry.npmjs.org/",
      ], `npm trust list ${name}`);
      return parseNpmJson(output, `npm trust list ${name}`);
    },
    create(name) {
      const output = runImpl([
        "trust", "github", name,
        "--file", EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
        "--repo", EXPECTED_TRUSTED_PUBLISHER.repository,
        "--env", EXPECTED_TRUSTED_PUBLISHER.environment,
        "--allow-publish",
        "--yes",
        "--json",
        "--registry", "https://registry.npmjs.org/",
      ], `npm trust github ${name}`);
      const configs = parseNpmJson(output, `npm trust github ${name}`);
      if (configs.length !== 1 || !exactNpmConfig(configs[0])) {
        throw error(`npm created an unexpected trusted-publisher configuration for ${name}`);
      }
    },
  };
}

function safeToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw error("CRATES_IO_TRUST_CONFIG_TOKEN must be a non-empty control-free secret");
  }
  return value;
}

async function boundedText(response, context) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    return text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function responseJson(response, context) {
  const text = await boundedText(response, context);
  if (!response.ok) throw error(`${context} returned HTTP ${response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw error(`${context} returned invalid JSON`);
  }
}

function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export function createCratesIoTrustClient({
  token = process.env.CRATES_IO_TRUST_CONFIG_TOKEN,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const secret = safeToken(token);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${secret}`,
    "User-Agent": "oliphaunt-trust-config/1; https://github.com/f0rr0/oliphaunt",
  };
  return {
    async list(name) {
      const url = new URL(CRATES_IO_CONFIG_ENDPOINT);
      url.searchParams.set("crate", name);
      url.searchParams.set("per_page", "100");
      let lastError;
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetchImpl(url, {
            method: "GET",
            headers,
            redirect: "error",
            signal: requestSignal(),
          });
          if (registryStatusRetryable(response.status) && attempt + 1 < MAX_READ_ATTEMPTS) {
            const seconds = registryRetryDelaySeconds({ headers: response.headers, attempt });
            await boundedText(response, `crates.io trust audit for ${name}`);
            await sleepImpl(seconds * 1_000);
            continue;
          }
          const body = await responseJson(response, `crates.io trust audit for ${name}`);
          if (!Array.isArray(body?.github_configs)) throw error(`crates.io trust audit for ${name} omitted github_configs`);
          if (body.github_configs.length > 5) throw error(`crates.io trust audit for ${name} exceeded the registry's five-config limit`);
          return body.github_configs;
        } catch (cause) {
          lastError = cause;
          if (
            attempt + 1 >= MAX_READ_ATTEMPTS
            || !(cause?.name === "TimeoutError" || cause instanceof TypeError)
          ) throw cause;
          await sleepImpl(registryRetryDelaySeconds({ attempt }) * 1_000);
        }
      }
      throw lastError;
    },
    async create(name) {
      const response = await fetchImpl(CRATES_IO_CONFIG_ENDPOINT, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          github_config: {
            crate: name,
            repository_owner: EXPECTED_TRUSTED_PUBLISHER.repositoryOwner,
            repository_name: EXPECTED_TRUSTED_PUBLISHER.repositoryName,
            workflow_filename: EXPECTED_TRUSTED_PUBLISHER.workflowFilename,
            environment: EXPECTED_TRUSTED_PUBLISHER.environment,
          },
        }),
        redirect: "error",
        signal: requestSignal(),
      });
      const body = await responseJson(response, `crates.io trust creation for ${name}`);
      if (!exactCratesConfig(body?.github_config, name)) {
        throw error(`crates.io created an unexpected trusted-publisher configuration for ${name}`);
      }
    },
  };
}

async function auditIdentities({ identities, ecosystem, client, spacingMs, sleepImpl, progress }) {
  const results = [];
  for (const [index, identity] of identities.entries()) {
    const configs = await client.list(identity.name);
    const classified = ecosystem === "npm"
      ? classifyNpmTrustConfigs(configs)
      : classifyCratesIoTrustConfigs(configs, identity.name);
    results.push({ id: identity.id, ...classified });
    progress?.(`audit ${index + 1}/${identities.length} ${identity.id}: ${classified.state}`);
    await sleepImpl(spacingMs);
  }
  return results;
}

function reportEnvelope({ plan, selection, ecosystem, mode, initial, final = initial, created = [] }) {
  const states = (rows, state) => rows.filter((row) => row.state === state).map(({ id }) => id);
  return {
    schema: TRUSTED_PUBLISHER_REPORT_SCHEMA,
    mode,
    ecosystem,
    lockDigest: plan.lockDigest,
    catalogDigest: plan.catalogDigest,
    selection: {
      count: selection.identities.length,
      batch: selection.batch,
      batches: selection.batches,
    },
    exact: states(final, "exact"),
    missing: states(final, "missing"),
    conflicts: final.filter(({ state }) => state === "conflict").map(({ id, reason }) => ({ id, reason })),
    created,
    initial: {
      exact: states(initial, "exact").length,
      missing: states(initial, "missing").length,
      conflicts: states(initial, "conflict").length,
    },
  };
}

export async function reconcileTrustedPublishers({
  plan,
  ecosystem,
  batch = undefined,
  apply = false,
  client,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  progress = undefined,
} = {}) {
  const selection = selectTrustedPublisherIdentities(plan, ecosystem, batch);
  const spacingMs = ecosystem === "npm" ? NPM_TRUST_REQUEST_SPACING_MS : CRATES_IO_TRUST_REQUEST_SPACING_MS;
  const initial = await auditIdentities({ ...selection, ecosystem, client, spacingMs, sleepImpl, progress });
  if (!apply || initial.some(({ state }) => state === "conflict")) {
    return reportEnvelope({ plan, selection, ecosystem, mode: apply ? "apply-blocked" : "audit", initial });
  }
  const missing = new Set(initial.filter(({ state }) => state === "missing").map(({ id }) => id));
  const created = [];
  for (const identity of selection.identities.filter(({ id }) => missing.has(id))) {
    await client.create(identity.name);
    created.push(identity.id);
    progress?.(`created ${created.length}/${missing.size} ${identity.id}`);
    await sleepImpl(spacingMs);
  }
  const final = await auditIdentities({ ...selection, ecosystem, client, spacingMs, sleepImpl, progress });
  return reportEnvelope({ plan, selection, ecosystem, mode: "apply", initial, final, created });
}

function parseArgs(argv) {
  const allowedValues = new Set(["lock", "products-json", "ecosystem", "batch", "confirm-lock-digest"]);
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply" || arg === "--audit" || arg === "--help" || arg === "-h") {
      booleans.add(arg.replace(/^-+/u, ""));
      continue;
    }
    if (!arg.startsWith("--")) throw error(`unexpected positional argument ${arg}`);
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    if (!allowedValues.has(key)) throw error(`unknown argument --${key}`);
    const value = separator === -1 ? argv[++index] : arg.slice(separator + 1);
    if (value === undefined || value.length === 0) throw error(`--${key} requires a value`);
    if (values.has(key)) throw error(`--${key} may be specified only once`);
    values.set(key, value);
  }
  return { values, booleans };
}

function productsValue(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw error("--products-json must be strict JSON");
  }
}

function usage() {
  return [
    "usage:",
    "  trusted-publisher-config.mjs [--lock FILE] [--products-json JSON]",
    "  trusted-publisher-config.mjs --audit --ecosystem cargo|npm [--batch N] [--lock FILE] [--products-json JSON]",
    "  trusted-publisher-config.mjs --apply --confirm-lock-digest SHA256 --ecosystem cargo|npm [--batch N] [--lock FILE] [--products-json JSON]",
    "",
    "No --audit/--apply: print an exact-lock plan without registry authentication or network access.",
    "--audit: authenticated read-only comparison. --apply: create only missing exact configs, then re-audit.",
    "npm requires deterministic batches sized for its documented five-minute 2FA window.",
  ].join("\n");
}

async function main(argv) {
  const { values, booleans } = parseArgs(argv);
  if (booleans.has("help") || booleans.has("h")) {
    console.log(usage());
    return 0;
  }
  if (booleans.has("audit") && booleans.has("apply")) throw error("--audit and --apply are mutually exclusive");
  const lockFile = path.resolve(ROOT, values.get("lock") ?? DEFAULT_PUBLICATION_LOCK);
  const plan = buildTrustedPublisherPlan(loadPublicationLock(lockFile), {
    products: productsValue(values.get("products-json")),
  });
  if (!booleans.has("audit") && !booleans.has("apply")) {
    if (values.has("ecosystem") || values.has("batch") || values.has("confirm-lock-digest")) {
      throw error("--ecosystem, --batch, and --confirm-lock-digest require --audit or --apply");
    }
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const ecosystem = values.get("ecosystem");
  const batch = values.has("batch") ? Number(values.get("batch")) : undefined;
  if (booleans.has("apply")) {
    const confirmed = values.get("confirm-lock-digest");
    if (confirmed !== plan.lockDigest) {
      throw error(`--confirm-lock-digest must exactly equal ${plan.lockDigest}`);
    }
  } else if (values.has("confirm-lock-digest")) {
    throw error("--confirm-lock-digest is used only with --apply");
  }
  let client;
  if (ecosystem === "npm") {
    client = createNpmTrustClient();
    client.checkRuntime();
  } else if (ecosystem === "cargo") {
    client = createCratesIoTrustClient();
  }
  const report = await reconcileTrustedPublishers({
    plan,
    ecosystem,
    batch,
    apply: booleans.has("apply"),
    client,
    progress: (line) => console.error(line),
  });
  console.log(JSON.stringify(report, null, 2));
  return report.missing.length === 0 && report.conflicts.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 2;
  }
}
